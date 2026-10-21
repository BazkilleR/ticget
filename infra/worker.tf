# Worker tier: scales on queue depth. +1 instance while 100+ messages wait, -1 once the queue is empty.

locals {
  worker_steps = {
    out = { comparison = "GreaterThanOrEqualToThreshold", threshold = 100, adjustment = 1 }
    in  = { comparison = "LessThanOrEqualToThreshold", threshold = 0, adjustment = -1 }
  }
}

resource "aws_autoscaling_policy" "worker_queue" {
  for_each                = local.worker_steps
  name                    = "queue-depth-${each.key}"
  autoscaling_group_name  = aws_autoscaling_group.app["worker"].name
  policy_type             = "StepScaling"
  adjustment_type         = "ChangeInCapacity"
  metric_aggregation_type = "Maximum"

  step_adjustment {
    scaling_adjustment          = each.value.adjustment
    metric_interval_lower_bound = each.key == "out" ? 0 : null
    metric_interval_upper_bound = each.key == "in" ? 0 : null
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_queue" {
  for_each            = local.worker_steps
  alarm_name          = "${local.name}-queue-depth-${each.key}"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.booking.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  alarm_actions       = [aws_autoscaling_policy.worker_queue[each.key].arn]
}
