# Docs: https://registry.terraform.io/modules/terraform-aws-modules/lambda/aws/latest
# VPC config:
# - https://www.serverless.com/framework/docs/providers/aws/guide/functions#vpc-configuration
# - https://docs.aws.amazon.com/lambda/latest/dg/services-rds-tutorial.html

module "lambda_function" {
  source = "terraform-aws-modules/lambda/aws"

  function_name = "${local.name}-lambda"
  description   = "${local.name} main lambda function"
  handler       = "index.lambda_handler"
  runtime       = "python3.8"

  publish = true

  source_path = "./handler"

  attach_network_policy  = true
  vpc_subnet_ids         = module.vpc.private_subnets
  vpc_security_group_ids = [module.lambda_sg.security_group_id]

  allowed_triggers = {
    AllowExecutionFromAPIGateway = {
      service    = "apigateway"
      source_arn = "${module.api_gateway.apigatewayv2_api_execution_arn}/*/*"
    }
  }

  attach_policy_statements = true
  policy_statements = {
    manage_connections = {
      effect    = "Allow",
      actions   = ["execute-api:ManageConnections"],
      resources = ["${module.api_gateway.default_apigatewayv2_stage_execution_arn}/*"]
    }
#    dynamodb = {
#      effect    = "Allow",
#      actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
#      resources = [module.dynamodb_table.dynamodb_table_arn]
#    }
    secrets = {
      effect = "Allow",
      actions = ["secretsmanager:GetSecretValue"],
      resources = [aws_secretsmanager_secret.rds.arn]
    }
#    rds_proxy = {
#      effect = "Allow",
#      actions = ["rds-db:connect"],
#      resources = [module.rds_proxy.proxy_arn]
#    }
  }

  environment_variables = {
    secrets_arn = aws_secretsmanager_secret.rds.arn
    db_name = module.rds.rds_cluster_database_name
    db_cluster_arn = module.rds.rds_cluster_arn
  }

}
