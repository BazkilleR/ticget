const fs = require('fs');
const path = require('path');
const cdk = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const autoscaling = require('aws-cdk-lib/aws-autoscaling');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const rds = require('aws-cdk-lib/aws-rds');
const elasticache = require('aws-cdk-lib/aws-elasticache');
const sqs = require('aws-cdk-lib/aws-sqs');
const secretsmanager = require('aws-cdk-lib/aws-secretsmanager');
const logs = require('aws-cdk-lib/aws-logs');
const iam = require('aws-cdk-lib/aws-iam');
const s3assets = require('aws-cdk-lib/aws-s3-assets');
const lambda = require('aws-cdk-lib/aws-lambda');
const { NodejsFunction } = require('aws-cdk-lib/aws-lambda-nodejs');
const apigw = require('aws-cdk-lib/aws-apigatewayv2');
const { HttpAlbIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const scheduler = require('aws-cdk-lib/aws-scheduler');
const schedulerTargets = require('aws-cdk-lib/aws-scheduler-targets');

const { Duration, RemovalPolicy, CfnOutput } = cdk;

const REPO_ROOT = path.join(__dirname, '..', '..');
const IMAGE_TARBALL = path.join(__dirname, '..', '.build', 'image.tar.gz');
const IMAGE_TAG = 'ticket-backend:aws';
const APP_PORT = 3000;
const DB_NAME = 'tickets';
const ISOLATED = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

// Everything is sized for the lowest cost and torn down with `npm run aws:destroy` after each test session.
//
//   Internet -> API Gateway (HTTP API, throttled) -> VPC Link -> internal ALB -> API ASG (EC2)
//   API -> SQS FIFO (+DLQ) -> worker ASG (EC2, scales on queue depth)
//   API/worker/Lambda -> RDS PostgreSQL, ElastiCache Redis
//   EventBridge Scheduler (15 min) -> Lambda (expire.js)
//
// No NAT gateway: subnets are isolated. Instances reach AWS services through VPC endpoints: S3 (gateway,
// free: Amazon Linux packages + the app image), SQS, Secrets Manager and CloudWatch Logs (interface, in one
// AZ to halve their hourly cost).
class TicketStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    if (!fs.existsSync(IMAGE_TARBALL)) {
      throw new Error(`App image not found at ${IMAGE_TARBALL}. Run "npm run aws:build-image" first.`);
    }

    // ---- Network ---------------------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    const endpointSubnets = { ...ISOLATED, availabilityZones: [vpc.availabilityZones[0]] };
    vpc.addInterfaceEndpoint('SqsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SQS,
      subnets: endpointSubnets,
    });
    vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: endpointSubnets,
    });
    vpc.addInterfaceEndpoint('LogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: endpointSubnets,
    });

    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', { vpc, description: 'API instances' });
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', { vpc, description: 'Worker instances' });
    const lambdaSg = new ec2.SecurityGroup(this, 'ExpireFnSg', { vpc, description: 'Cleanup Lambda' });

    // EC2 Instance Connect Endpoint (no hourly charge): SSH to the private instances for debugging, and an
    // SSH tunnel to RDS/Redis for migrations, seeding and load-test setup (npm run aws:tunnel).
    const eicSg = new ec2.SecurityGroup(this, 'EicSg', { vpc, description: 'EC2 Instance Connect Endpoint' });
    new ec2.CfnInstanceConnectEndpoint(this, 'Eic', {
      subnetId: vpc.isolatedSubnets[0].subnetId,
      securityGroupIds: [eicSg.securityGroupId],
      preserveClientIp: false,
    });
    apiSg.addIngressRule(eicSg, ec2.Port.tcp(22), 'SSH via EC2 Instance Connect Endpoint');
    workerSg.addIngressRule(eicSg, ec2.Port.tcp(22), 'SSH via EC2 Instance Connect Endpoint');

    // ---- Data ------------------------------------------------------------------------------------------
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: ISOLATED,
      credentials: rds.Credentials.fromGeneratedSecret('app'),
      databaseName: DB_NAME,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: Duration.days(1),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const sg of [apiSg, workerSg, lambdaSg]) db.connections.allowDefaultPortFrom(sg);

    const cacheSg = new ec2.SecurityGroup(this, 'CacheSg', { vpc, description: 'ElastiCache Redis' });
    for (const sg of [apiSg, workerSg, lambdaSg]) cacheSg.addIngressRule(sg, ec2.Port.tcp(6379));
    const cacheSubnets = new elasticache.CfnSubnetGroup(this, 'CacheSubnets', {
      description: 'Ticket backend cache subnets',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    const cache = new elasticache.CfnCacheCluster(this, 'Cache', {
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: cacheSubnets.ref,
      vpcSecurityGroupIds: [cacheSg.securityGroupId],
    });
    const redisUrl = `redis://${cache.attrRedisEndpointAddress}:${cache.attrRedisEndpointPort}`;

    const dlq = new sqs.Queue(this, 'BookingDlq', {
      fifo: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const queue = new sqs.Queue(this, 'BookingQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: Duration.seconds(30),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      description: 'JWT signing secret for the ticket backend',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---- App image and shared runtime config -----------------------------------------------------------
    const image = new s3assets.Asset(this, 'AppImage', { path: IMAGE_TARBALL });

    // Non-secret config only. The containers resolve the two ARNs to DATABASE_URL / JWT_SECRET at boot.
    const baseEnv = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      AWS_REGION: this.region,
      REDIS_URL: redisUrl,
      SQS_BOOKING_QUEUE_URL: queue.queueUrl,
      DB_SECRET_ARN: db.secret.secretArn,
      JWT_SECRET_ARN: jwtSecret.secretArn,
      DB_NAME,
    };

    const machineImage = ec2.MachineImage.latestAmazonLinux2023();
    const instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO);

    const makeAppTier = (name, { securityGroup, command, runMigrations }) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.THREE_DAYS,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const role = new iam.Role(this, `${name}Role`, { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com') });
      image.grantRead(role);
      db.secret.grantRead(role);
      jwtSecret.grantRead(role);
      logGroup.grantWrite(role);

      const userData = ec2.UserData.forLinux();
      userData.addCommands(
        ...appBootScript({
          imageUrl: image.s3ObjectUrl,
          env: { ...baseEnv, DB_CA_FILE: '/app/certs/rds-global-bundle.pem' },
          logGroup: logGroup.logGroupName,
          region: this.region,
          command,
          runMigrations,
        }),
      );

      const launchTemplate = new ec2.LaunchTemplate(this, `${name}LaunchTemplate`, {
        instanceType,
        machineImage,
        userData,
        role,
        securityGroup,
        requireImdsv2: true,
        blockDevices: [
          { deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(8, { volumeType: ec2.EbsDeviceVolumeType.GP3 }) },
        ],
      });

      const asg = new autoscaling.AutoScalingGroup(this, `${name}Asg`, {
        vpc,
        vpcSubnets: ISOLATED,
        launchTemplate,
        minCapacity: 1,
        maxCapacity: 2,
        // A new launch template version (e.g. a new app image) replaces instances one at a time.
        updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({ maxBatchSize: 1 }),
      });
      return { asg, role, logGroup };
    };

    // ---- API tier: API Gateway -> VPC Link -> internal ALB -> ASG ---------------------------------------
    const api = makeAppTier('Api', { securityGroup: apiSg, command: 'node src/api.js', runMigrations: true });
    queue.grantSendMessages(api.role);
    // Boot (install Docker, pull the image, migrate) takes a few minutes before /health can pass.
    api.asg.node.defaultChild.healthCheckType = 'ELB';
    api.asg.node.defaultChild.healthCheckGracePeriod = 600;
    api.asg.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { vpc, vpcSubnets: ISOLATED, internetFacing: false });
    const listener = alb.addListener('Http', { port: 80, open: false });
    listener.addTargets('Api', {
      port: APP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [api.asg],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: { path: '/health', interval: Duration.seconds(15), healthyThresholdCount: 2 },
    });

    const vpcLinkSg = new ec2.SecurityGroup(this, 'VpcLinkSg', { vpc, description: 'API Gateway VPC Link' });
    alb.connections.allowFrom(vpcLinkSg, ec2.Port.tcp(80), 'API Gateway VPC Link');
    const vpcLink = new apigw.VpcLink(this, 'VpcLink', { vpc, subnets: ISOLATED, securityGroups: [vpcLinkSg] });

    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      createDefaultStage: false,
      defaultIntegration: new HttpAlbIntegration('Alb', listener, { vpcLink }),
    });
    // Rate limit at the edge, before anything reaches the ALB. Sized to let the 1,000-user load test through.
    const stage = httpApi.addStage('MainStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: 1000, burstLimit: 2000 },
    });

    // ---- Worker tier: scales on queue depth -------------------------------------------------------------
    const worker = makeAppTier('Worker', { securityGroup: workerSg, command: 'node src/worker.js', runMigrations: false });
    queue.grantConsumeMessages(worker.role);
    worker.asg.scaleOnMetric('QueueDepth', {
      metric: queue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }),
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 100, change: +1 },
      ],
      adjustmentType: autoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
    });

    // ---- Cleanup job: EventBridge Scheduler -> Lambda ----------------------------------------------------
    // AWS_REGION is reserved: the Lambda runtime sets it and rejects it in the function configuration.
    const { AWS_REGION: _reserved, ...lambdaEnv } = baseEnv;
    const expireFn = new NodejsFunction(this, 'ExpireFn', {
      entry: path.join(REPO_ROOT, 'src', 'jobs', 'expire-lambda.js'),
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_24_X,
      memorySize: 256,
      timeout: Duration.seconds(60),
      vpc,
      vpcSubnets: ISOLATED,
      securityGroups: [lambdaSg],
      environment: { ...lambdaEnv, DB_CA_FILE: '/var/task/rds-global-bundle.pem' },
      logGroup: new logs.LogGroup(this, 'ExpireFnLogs', {
        retention: logs.RetentionDays.THREE_DAYS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        // The Node.js Lambda runtime ships the AWS SDK v3; pg-native is an optional pg dependency we do not use.
        externalModules: ['@aws-sdk/*', 'pg-native'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [
            `cp "${inputDir}/certs/rds-global-bundle.pem" "${outputDir}/rds-global-bundle.pem"`,
          ],
        },
      },
    });
    db.secret.grantRead(expireFn);
    jwtSecret.grantRead(expireFn);

    new scheduler.Schedule(this, 'ExpireSchedule', {
      description: 'Release expired booking holds (src/jobs/expire.js)',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(15)),
      target: new schedulerTargets.LambdaInvoke(expireFn, {}),
    });

    cdk.Tags.of(this).add('project', 'ticket-backend');

    // ---- Outputs (read by infra/scripts/*.sh) ------------------------------------------------------------
    new CfnOutput(this, 'ApiUrl', { value: stage.url });
    new CfnOutput(this, 'ApiAsgName', { value: api.asg.autoScalingGroupName });
    new CfnOutput(this, 'WorkerAsgName', { value: worker.asg.autoScalingGroupName });
    new CfnOutput(this, 'DbEndpoint', { value: db.instanceEndpoint.hostname });
    new CfnOutput(this, 'DbSecretArn', { value: db.secret.secretArn });
    new CfnOutput(this, 'JwtSecretArn', { value: jwtSecret.secretArn });
    new CfnOutput(this, 'RedisEndpoint', { value: cache.attrRedisEndpointAddress });
    new CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new CfnOutput(this, 'ApiLogGroup', { value: api.logGroup.logGroupName });
    new CfnOutput(this, 'WorkerLogGroup', { value: worker.logGroup.logGroupName });
    new CfnOutput(this, 'ExpireFunctionName', { value: expireFn.functionName });
  }
}

// EC2 boot: install Docker, load the app image from S3, resolve secrets, (migrate,) start the container.
// Containers use the host network so the AWS SDK can reach instance metadata (IMDSv2, hop limit 1).
function appBootScript({ imageUrl, env, logGroup, region, command, runMigrations }) {
  const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const run = 'docker run --rm --network host --env-file /etc/ticket/base.env';
  return [
    'set -euxo pipefail',
    'exec > >(tee -a /var/log/app-boot.log) 2>&1',
    'dnf install -y docker',
    'systemctl enable --now docker',
    `aws s3 cp "${imageUrl}" /tmp/image.tar.gz --region ${region} --only-show-errors`,
    'docker load -i /tmp/image.tar.gz && rm -f /tmp/image.tar.gz',
    'install -d -m 700 /etc/ticket',
    "cat > /etc/ticket/base.env <<'ENV'",
    ...envLines,
    'ENV',
    `${run} ${IMAGE_TAG} node scripts/aws-env.js > /etc/ticket/secrets.env`,
    'chmod 600 /etc/ticket/*.env',
    ...(runMigrations ? [`${run} --env-file /etc/ticket/secrets.env ${IMAGE_TAG} node scripts/migrate.js`] : []),
    'TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")',
    'INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)',
    [
      'docker run -d --name app --restart unless-stopped --network host --stop-timeout 25',
      '--env-file /etc/ticket/base.env --env-file /etc/ticket/secrets.env',
      `--log-driver awslogs --log-opt awslogs-region=${region} --log-opt awslogs-group=${logGroup}`,
      '--log-opt awslogs-stream=$INSTANCE_ID',
      `${IMAGE_TAG} ${command}`,
    ].join(' '),
  ];
}

module.exports = { TicketStack };
