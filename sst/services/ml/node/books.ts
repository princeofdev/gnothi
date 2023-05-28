import {lambdaSend} from "../../aws/handlers"
import {insights_books_response} from '@gnothi/schemas/insights'
import {Config} from 'sst/node/config'
import * as S from "@gnothi/schemas"
import {sendInsight} from "./utils";

type FnIn = {
  context?: S.Api.FnContext
  search_mean: number[]
  usePrompt: boolean
}
type LambdaIn = FnIn
type LambdaOut = insights_books_response['books'][]
type FnOut = LambdaOut

export async function books({search_mean, context}: FnIn): Promise<FnOut> {
  // Get fnName while inside function because will only be present for FnBackground (not FnMain)
  const fnName = Config.FN_BOOKS_NAME
  let res: LambdaOut
  if (search_mean?.length) {
    const {Payload} = await lambdaSend<LambdaOut>(
      {embedding: search_mean},
      fnName,
      "RequestResponse"
    )
    res = Payload
  } else {
    res = []
  }
  await sendInsight(
    S.Routes.routes.insights_books_response,
    {books: res},
    context
  )
  return res
}
