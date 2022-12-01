import {z} from "zod";
import {TextDecoder} from "util";
import {InvokeCommand, InvokeCommandInput, InvokeCommandOutput, LambdaClient} from "@aws-sdk/client-lambda";
import {Readable} from "stream";
import {GetObjectCommand, PutObjectCommand, S3Client} from "@aws-sdk/client-s3";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  Callback,
  Context,
  APIGatewayProxyResultV2,
  APIGatewayProxyEventV2,
  APIGatewayEvent,
} from "aws-lambda";
import {Api, Events} from '@gnothi/schemas';
import {Config} from '@serverless-stack/node/config'
import {clients} from './clients'
import {SNSEvent} from "aws-lambda";
import {APIGatewayProxyWebsocketEventV2} from "aws-lambda/trigger/api-gateway-proxy";

export * as Handlers from './handlers'

type HandlerKey = "http" | "s3" | "sns" | "lambda" | "ws"
export function whichHandler(event: any, context: Context): HandlerKey {
  // TODO would multiple triggers ever hit the same Lambda at once?
  if (sns.match(event)) {return "sns"}
  if (ws.match(event)) {return "ws"}
  if (http.match(event)) {return "http"}
  // if (S3.match(event)) {return new S3()}
  return "lambda"
}

interface Handler<E = any> {
  match: (req: E) => boolean
  parse: (event: E) => Promise<Array<null | Api.Req>>
  respond: (res: Api.Res, opts: Api.FnContext) => Promise<APIGatewayProxyResultV2>
}

// TODO revisit, I can't figure this out
// export class SNS<E extends SNSEvent> extends Handler<E> {
export const sns: Handler<SNSEvent> = {
  match: (req) => {
    // return req.Records?.[0]?.EventSource === 'aws:sns'
    return !!req.Records?.[0]?.Sns?.Message
  },

  parse: async (event) => {
    const parsed = z.object({
      Records: z.array(
        z.object({
          Sns: z.object({
            Message: Api.AnyToObj,
            MessageAttributes: z.record(z.string(), z.object({
              Type: z.string(),
              Value: z.string()
            })).optional(),
          })
        })
      )
    }).parse(event)
    return parsed.Records.map(({Sns}) => {
      if (Sns.Message.eventName === "TestNotification") {
        return null
      }
      return {
        trigger: "sns",
        event: Sns.MessageAttributes?.event?.Value || "sns_notif",
        data: Sns.Message
      }
    })
  },

  // https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html
  respond: async (res) => {
    return {statusCode: 200}
  }
}

class Buff {
  static fromObj(obj: object): Buffer {
    return Buffer.from(JSON.stringify(obj))
  }

  // public static objFromBuff(buff: Buffer): object {
  static toObj(buff: Uint8Array): object {
    return JSON.parse(new TextDecoder().decode(buff))
  }
}

interface InvokeOutput {
  response: InvokeCommandOutput
  body: object
}

export async function lambdaSend(
  data: object,
  FunctionName: string,
  InvocationType: InvokeCommandInput["InvocationType"] = "RequestResponse"
): Promise<InvokeCommandOutput> {
  const Payload = Buff.fromObj(data)
  const params = {
    InvocationType,
    Payload,
    FunctionName,
  }
  const response = await clients.lambda.send(new InvokeCommand(params))
  const whatsThis = Buff.toObj(response.Payload)
  debugger
  return response
}

export const lambda: Handler<any> = {
  match: (event) => true,

  parse: async (event) => {
    // FIXME
    return [event]
  },

  respond: async (res) => {
    const {data, event} = res
    const response = await lambdaSend(data as object, Config.fnFixMe)
    let responseBody: object = {}
    console.log(event, "response")
    if (response.Payload) {
      // Revisit how to decode the Payload. Buffer vs Uint8Array?
      responseBody = Buff.toObj(response.Payload)
      console.log(responseBody)
    } else {
      console.log(response)
    }
    // return {response, body: responseBody}
    return {statusCode: 200, data: response}
  }
}

export const ws: Handler<APIGatewayProxyWebsocketEventV2> = {
  match: (event) => !!event.requestContext?.connectionId,

  parse: async (event) => {
    const parsed = z.object({
      requestContext: z.object({
        connectionId: z.string(),
        routeKey: z.string(), // $connect, $disconnect, $default, other (based on websocketApiRouteSelectionExpression)
      }),
      body: Api.AnyToObj
    }).parse(event)
    return [{
      trigger: 'ws',
      // connectionId: val.requestContext.connectionId,
      ...parsed.body
    }]
  },

  async respond(res, {connectionId}): Promise<APIGatewayProxyResultV2> {
    // if (!connectionId) { return }
    try {
      // try/catch because the connection may have gone away
      await clients.apig.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buff.fromObj(res),
      }))
    } catch (e) {
      console.error(e)
    }
    return {statusCode: 200}
  }
}

export const http: Handler<APIGatewayProxyEventV2> = {
  match: (event) => !!event?.requestContext?.http?.method,

  parse: async (event) => {
    if (event.rawPath === '/favicon.ico'
      || event.requestContext.http.method === "OPTIONS") {
      return [null]
    }

    // https://docs.aws.amazon.com/lambda/latest/dg/services-apigateway.html#apigateway-example-event
    const parsed = z.object({
      requestContext: z.object({
        http: z.object({
          method: z.string(),
          path: z.string(),
        }),
      }),
      body: Api.AnyToObj
    }).parse(event)
    return [{
      trigger: 'http',
      ...parsed.body
    }]
  },

  respond: async (response) => {
    return {
      statusCode: response.code,
      body: JSON.stringify(response)
    }
  }
}

export const handlers = {
  ws, http, sns, lambda
}