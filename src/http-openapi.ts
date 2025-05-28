import * as fs from 'fs'

import { DomainName } from '@aws-cdk/aws-apigatewayv2-alpha'
import {
  aws_certificatemanager as acm,
  aws_apigatewayv2 as apigwv2, ArnFormat, Duration,
  aws_lambda as lambda, Resource, aws_route53 as route53,
  Stack,
  Token,
  ValidationError
} from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as YAML from 'yaml'

import { CorsOptions, Deployment, Integration, IResource, IRestApi, MethodOptions, ResourceBase, Stage } from 'aws-cdk-lib/aws-apigateway'
import { CorsConfigAllOrigins } from './cors'
import { HttpApiProps, MethodMapping } from './types'

const AUTHORIZER_KEY = 'custom_authorizer'

export class HttpOpenApi extends Resource implements IRestApi {
  restApiId: string

  restApiName: string

  restApiRootResourceId: string

  latestDeployment?: Deployment | undefined

  deploymentStage: Stage

  root: IResource

  arnForExecuteApi(method: string = '*', path: string = '/*', stage: string = '*'): string {
    if (!Token.isUnresolved(path) && !path.startsWith('/')) {
      throw new ValidationError(`"path" must begin with a "/": '${path}'`, this)
    }

    if (method.toUpperCase() === 'ANY') {
      method = '*'
    }

    return Stack.of(this).formatArn({
      service: 'execute-api',
      resource: this.restApiId,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      resourceName: `${stage}/${method}${path}`
    })
  }

  stack: Stack

  /**
   *  Api Resource being created based on openAPI definition
   */
  public readonly cfnApi: apigwv2.CfnApi

  /**
   * Default stage being created & deployed for the API
   */
  public readonly apiStage: apigwv2.CfnStage

  /**
   * Maps operationId to lambda Function that is being created
   */
  public readonly functions: Record<string, lambda.Function>

  public readonly permissions: Record<string, lambda.CfnPermission>

  /**
   * Maps operationId to http path and method - for routing purposes
   */
  public readonly methodMappings: Record<string, MethodMapping>

  constructor(scope: Construct, id: string, props: HttpApiProps) {
    super(scope, id)

    this.functions = {}
    this.permissions = {}

    const file = fs.readFileSync(props.openApiSpec, 'utf8')
    const spec = YAML.parse(file)
    this.stack = Stack.of(this)

    this.methodMappings = this.buildMethodMappings(spec)

    this.cfnApi = new apigwv2.CfnApi(this, `${props.functionNamePrefix}`, {
      body: spec,
      tags: undefined
    })

    this.restApiId = this.cfnApi.ref
    this.restApiName = this.cfnApi.ref
    this.restApiRootResourceId = `${this.restApiId}-root`
    this.root = new RootResource(this, this.restApiRootResourceId)
    this.deploymentStage = new Stage(this, '$default', { deployment: new Deployment(this, 'deployment', { api: this }) })

    this.apiStage = new apigwv2.CfnStage(this, 'DefaultStage', {
      apiId: this.cfnApi.ref,
      stageName: '$default',
      autoDeploy: true
    })

    props.integrations.forEach((integration) => {
      const method = this.methodMappings[integration.operationId]
      if (!method) {
        throw new Error(`There is no path in the Open API Spec matching ${integration.operationId}`)
      } else {
        const funcName = `${props.functionNamePrefix}-${integration.operationId}`
        // TODO: Think about using NodeJS Lambdas
        const func = new lambda.Function(this, funcName, {
          functionName: funcName,
          runtime: integration.runtime,
          code: lambda.AssetCode.fromAsset(
            integration.sourcePath
          ),
          handler: integration.handler,
          logRetention: integration.logRetention ?? 90,
          timeout: integration.timeout ?? Duration.seconds(3),
          memorySize: integration.memorySize ?? 128,
          environment: integration.environment
        })

        this.functions[integration.operationId] = func

        if (props.customAuthorizerLambdaArn) {
          spec.paths[method.path][method.method].security = [
            {
              [AUTHORIZER_KEY]: []
            }
          ]
        }

        spec.paths[method.path][method.method][
          'x-amazon-apigateway-integration'
        ] = {
          type: 'AWS_PROXY',
          httpMethod: 'POST',
          uri: func.functionArn,
          payloadFormatVersion: '2.0'
        }
      }
    })

    // First loop with authorizers to add their configurations to the spec
    if (props.customAuthorizerLambdaArn) {
      spec.components.securitySchemes = {}
      // https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-swagger-extensions-authorizer.html
      spec.components.securitySchemes[AUTHORIZER_KEY] =
        this.toAuthorizerSpec(props.customAuthorizerLambdaArn, this.stack.region)
    }

    // add passed or default cors
    if (props.corsConfig) {
      spec['x-amazon-apigateway-cors'] = props.corsConfig
    } else if (props.corsAllowAllOrigins) {
      // Allow all origins
      spec['x-amazon-apigateway-cors'] = CorsConfigAllOrigins
    }

    // Second loop with Authorizers, in order to add InvokeFunction permission
    // to the created API. It has to be separated because we need the ref from cfnApi
    if (props.customAuthorizerLambdaArn) {
      const permission = new lambda.CfnPermission(this, 'AuthorizerPermission', {
        action: 'lambda:InvokeFunction',
        principal: 'apigateway.amazonaws.com',
        functionName: props.customAuthorizerLambdaArn,
        sourceArn: `arn:aws:execute-api:${this.stack.region}:${this.stack.account}:${this.cfnApi.ref}/*/*/*`
      })
      this.permissions[AUTHORIZER_KEY] = permission
    }

    Object.keys(this.functions).forEach((funcKey, idx) => {
      const func = this.functions[funcKey]
      const permission = new lambda.CfnPermission(this, `LambdaPermission_${idx}`, {
        action: 'lambda:InvokeFunction',
        principal: 'apigateway.amazonaws.com',
        functionName: func.functionName,
        sourceArn: `arn:${this.stack.partition}:execute-api:${this.stack.region}:${this.stack.account}:${this.cfnApi.ref}/*/*`
      })
      this.permissions[funcKey] = permission
    })
  }

  /**
   * Enable custom domain for this API
   * @param customDomainName - customDomainName to be created in Api Gateway
   * @param certificateArn Arn of the certificate needed for the creation of custom domain. It must be a regional certificate.
   */
  public enableCustomDomain(
    customDomainName: string,
    certificateArn: string,
    zoneName: string
  ) {
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'DomainCertificate',
      certificateArn
    )

    const domainName = new DomainName(this, 'CustomDomainName', {
      domainName: customDomainName,
      certificate
    })

    const routeConfig: route53.ARecordProps = {
      recordName: customDomainName,
      zone: route53.HostedZone.fromLookup(this, 'ZoneLookup', {
        domainName: zoneName
      }),
      target: route53.RecordTarget.fromAlias({
        bind: () => ({
          dnsName: domainName.regionalDomainName,
          hostedZoneId: domainName.regionalHostedZoneId
        })
      })
    }
    const aRecord = new route53.ARecord(this, 'CustomDomainARecord', routeConfig)
    const aaaaRecord = new route53.AaaaRecord(this, 'CustomDomainAAAARecord', routeConfig)

    const apiMapping = new apigwv2.CfnApiMapping(this, 'CustomDomainApiMapping', {
      apiId: this.cfnApi.ref,
      domainName: customDomainName,
      stage: this.apiStage.stageName
    })

    apiMapping.addDependsOn(this.cfnApi)
    apiMapping.addDependsOn(this.apiStage)
    apiMapping.node.addDependency(domainName)
    apiMapping.node.addDependency(aRecord)
    apiMapping.node.addDependency(aaaaRecord)
  }

  /**
   * Extracts path and method that map to the operationId needed
   * So finding the right place on the spec is just a matter of accessing the right attribute
   * @param spec
   * @returns methods
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildMethodMappings(spec: any) {
    const methods = {} as Record<string, MethodMapping>

    Object.entries(spec.paths).forEach(([path, pathObj]: [string, any]) => {
      Object.keys(pathObj).forEach((method) => {
        methods[pathObj[method]['x-amazon-apigateway-integration'].uri] = {
          path,
          method
        }
      })
    })

    return methods
  }

  private toAuthorizerSpec(lambdaAuthorizerArn: string, region: string) {
    const uri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${lambdaAuthorizerArn}/invocations`

    return {
      type: 'apiKey',
      name: 'Authorization',
      in: 'header',
      'x-amazon-apigateway-authorizer': {
        type: 'request',
        identitySource: '$request.header.Authorization', // Request parameter mapping expression of the identity source. In this example, it is the 'auth' header.
        authorizerUri: uri,
        authorizerPayloadFormatVersion: '2.0',
        authorizerResultTtlInSeconds: 300
      }
    }
  }
}

export class RootResource extends ResourceBase {
  parentResource?: IResource | undefined
  api: IRestApi
  resourceId: string
  path: string
  defaultIntegration?: Integration | undefined
  defaultMethodOptions?: MethodOptions | undefined
  defaultCorsPreflightOptions?: CorsOptions | undefined

  constructor(api: IRestApi, resourceId: string) {
    super(api, resourceId)
    this.api = api
    this.resourceId = resourceId
    this.path = '/'
  }
}
