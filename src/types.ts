import { Duration } from 'aws-cdk-lib'
import { CfnApi } from 'aws-cdk-lib/aws-apigatewayv2'
import { ILayerVersion, Runtime } from 'aws-cdk-lib/aws-lambda'
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2'

export interface HttpApiProps {
  /**
   * Prefix to be used for the lambdas names.
   */
  readonly functionNamePrefix: string

  /**
   * Path to Open API 3.0 definition file.
   *
   * @example
   * {
   *   openApiSpec: './openapi.yml'
   *   ...
   * }
   *
   */
  readonly openApiSpec: string

  /**
   * List of integrations: for each operationId a handler must be defined.
   *
   * Handlers are following format: file.method
   * @example
   * [
   *  {
   *    operationId: 'getEntity',
   *    handler: 'api.getEntity'
   *  }
   * ]
   */
  readonly integrations: HttpApiIntegrationProps[]

  /**
   * ARN of the lambda to be used as a custom authorizer for your requests
   */
  readonly customAuthorizerLambdaArn?: string

  /**
   * Cors configuration for the api gateway.
   * all origins/methods/headers are allowed by default, set a value for this attribute to override default value
   *
   * @example
   * [
   *  {
   *    allowCredentials: true,
   *    allowHeaders: ['*'],
   *    allowMethods: ['*'],
   *    allowOrigins: ['*']
   *  }
   * ]
   */
  readonly corsConfig?: CfnApi.CorsProperty

  readonly acls?: CfnWebACL
}

export interface HttpApiIntegrationProps {
  readonly operationId: string
  readonly handler: string
  readonly runtime: Runtime
  readonly sourcePath: string
  readonly logRetention?: number
  readonly timeout?: Duration
  readonly memorySize?: number
  readonly layers?: ILayerVersion[]
  readonly environment?: Record<string, string>
}

export interface MethodMapping {
  readonly path: string
  readonly method: string
}
