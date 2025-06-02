import * as fs from 'fs'

import { DomainName } from '@aws-cdk/aws-apigatewayv2-alpha'
import {
  aws_certificatemanager as acm,
  aws_apigatewayv2 as apigwv2, Duration, aws_lambda as lambda, aws_route53 as route53,
  Stack
} from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as YAML from 'yaml'

import { CorsOptions, Integration, IntegrationType, IResource, IRestApi, MethodOptions, ResourceBase } from 'aws-cdk-lib/aws-apigateway'
import { CfnApi, CfnIntegration, CfnRoute, CfnStage, PayloadFormatVersion } from 'aws-cdk-lib/aws-apigatewayv2'
import { CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2'
import { HttpApiProps, MethodMapping } from './types'

const AUTHORIZER_KEY = 'custom_authorizer'

export class HttpOpenApi extends Construct {
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

  public readonly routes: CfnRoute[] = []

  /**
   * Maps operationId to http path and method - for routing purposes
   */
  public readonly methodMappings: Record<string, MethodMapping>

  public readonly association?: CfnWebACLAssociation

  constructor(scope: Construct, id: string, props: HttpApiProps) {
    super(scope, id)

    this.functions = {}
    this.permissions = {}

    const file = fs.readFileSync(props.openApiSpec, 'utf8')
    const spec = YAML.parse(file)
    const stack = Stack.of(this)

    this.methodMappings = this.buildMethodMappings(spec)

    this.cfnApi = new CfnApi(this, `${props.functionNamePrefix}-api`, {
      name: `${props.functionNamePrefix}-api`,
      corsConfiguration: props.corsConfig,
      protocolType: 'HTTP'
    })

    this.apiStage = new CfnStage(this, `${props.functionNamePrefix}-stage`, {
      apiId: this.cfnApi.attrApiId,
      stageName: '$default',
      autoDeploy: true
    })

    if (props.acls) {
      this.association = new CfnWebACLAssociation(this, `${props.functionNamePrefix}-waf-association`, {
        resourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${this.cfnApi.attrApiId}/*/*/*`,
        webAclArn: props.acls.attrArn
      })
    }

    props.integrations.forEach((integration) => {
      const method = this.methodMappings[integration.operationId]
      if (!method) {
        throw new Error(`There is no path in the Open API Spec matching ${integration.operationId}`)
      } else {
        const functionName = `${props.functionNamePrefix}-${integration.operationId}`
        const func = new lambda.Function(this, functionName, {
          ...integration,
          functionName,
          code: lambda.AssetCode.fromAsset(
            integration.sourcePath
          ),
          logRetention: integration.logRetention ?? 90,
          timeout: integration.timeout ?? Duration.seconds(3),
          memorySize: integration.memorySize ?? 128
        })

        this.functions[integration.operationId] = func

        const intgr = new CfnIntegration(this, `integration-${method.path.replace(/\//g, '-')}-${method.method}`, {
          apiId: this.cfnApi.attrApiId,
          integrationType: IntegrationType.AWS_PROXY,
          payloadFormatVersion: PayloadFormatVersion.VERSION_2_0.version,
          integrationUri: `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${func.functionArn}/invocations`
        })

        const route = new CfnRoute(this, `route-${method.path.replace(/\//g, '-')}-${method.method}`, {
          apiId: this.cfnApi.attrApiId,
          routeKey: `${method.method.toUpperCase()} ${method.path}`,
          target: `integrations/${intgr.attrIntegrationId}`
        })
        this.routes.push(route)

        if (props.customAuthorizerLambdaArn) {
          spec.paths[method.path][method.method].security = [
            {
              [AUTHORIZER_KEY]: []
            }
          ]
        }
      }
    })

    // First loop with authorizers to add their configurations to the spec
    if (props.customAuthorizerLambdaArn) {
      spec.components.securitySchemes = {}
      // https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-swagger-extensions-authorizer.html
      spec.components.securitySchemes[AUTHORIZER_KEY] =
        this.toAuthorizerSpec(props.customAuthorizerLambdaArn, stack.region)
    }

    // Second loop with Authorizers, in order to add InvokeFunction permission
    // to the created API. It has to be separated because we need the ref from cfnApi
    if (props.customAuthorizerLambdaArn) {
      const permission = new lambda.CfnPermission(this, 'AuthorizerPermission', {
        action: 'lambda:InvokeFunction',
        principal: 'apigateway.amazonaws.com',
        functionName: props.customAuthorizerLambdaArn,
        sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${this.cfnApi.attrApiId}/*/*/*`
      })
      this.permissions[AUTHORIZER_KEY] = permission
    }

    Object.keys(this.functions).forEach((funcKey, idx) => {
      const func = this.functions[funcKey]
      const permission = new lambda.CfnPermission(this, `LambdaPermission_${idx}`, {
        action: 'lambda:InvokeFunction',
        principal: 'apigateway.amazonaws.com',
        functionName: func.functionName,
        sourceArn: `arn:${stack.partition}:execute-api:${stack.region}:${stack.account}:${this.cfnApi.attrApiId}/*/*`
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
      apiId: this.cfnApi.attrApiId,
      domainName: customDomainName,
      stage: this.apiStage.stageName
    })

    apiMapping.node.addDependency(this.cfnApi)
    apiMapping.node.addDependency(this.apiStage)
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
