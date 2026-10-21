# The app image built by `npm run aws:build-image` goes to S3 and the EC2 instances `docker load` it:
# no ECR, so no ECR VPC endpoints to pay for. The key carries the file hash, so a new image changes the user
# data, which makes a new launch template version and an instance refresh.

locals {
  image_tarball = "${path.module}/.build/image.tar.gz"
  # fileexists keeps `terraform destroy` working without a local build; the precondition below guards apply.
  image_hash = fileexists(local.image_tarball) ? filemd5(local.image_tarball) : "missing"
}

resource "aws_s3_bucket" "assets" {
  bucket_prefix = "${local.name}-assets-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "image" {
  bucket      = aws_s3_bucket.assets.id
  key         = "image-${local.image_hash}.tar.gz"
  source      = local.image_tarball
  source_hash = local.image_hash # not etag: a multipart upload's ETag is not the MD5

  lifecycle {
    precondition {
      condition     = fileexists(local.image_tarball)
      error_message = "App image not found at infra/.build/image.tar.gz. Run \"npm run aws:build-image\" first."
    }
  }
}
