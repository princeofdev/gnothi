import * as S from '@gnothi/schemas'
import {db} from '../../data/db'
import {GnothiError} from "../errors";
import {completion} from '../../ml/node/openai'
import {z} from 'zod'
// @ts-ignore
import dayjs from 'dayjs'
import {ulid} from 'ulid'
import {Insights} from '../../data/models/insights'
import {Entry} from '@gnothi/schemas/entries'

const r = S.Routes.routes

// prioritize clean-text, worst-case markdown
function getText (e: Entry): string {
  return e.text_clean || e.text
}
// prioritize summary, worst-case full-text
function getSummary(e: Entry): string {
  return e.ai_text || getText(e)
}
function getParas(e: Entry): string[] {
  if (e.text_paras?.length) {
    return e.text_paras
  }
  // TODO text_clean won't have paras, it's clean-join()'d, no paras preserved. This line
  // should be rare though, since text_paras is likely available by now.
  return getText(e).split(/\n+/)
}

r.insights_prompt_request.fn = r.insights_prompt_request.fnDef.implement(async (req, context) => {
  const mInsights = new Insights(context.user.id)
  const entries = await mInsights.entriesByIds(req.entry_ids)
  const {prompt, view} = req

  const placeholder = {
    entry: !!~prompt.indexOf('<entry>'),
    paragraphs: !!~prompt.indexOf('<paragraphs>'),
    summary: !!~prompt.indexOf('<summary>'),
  }
  const hasMultiple = Object.values(placeholder).filter(Boolean).length > 1
  if (hasMultiple) {
    throw new GnothiError({message: "Only one placeholder can be used at a time for now. This many change later."})
  }

  let response: string
  if (placeholder.paragraphs) {
    if (view === 'list') {
      throw new GnothiError({message: "Can't yet use <paragraphs> in list view. When implemented, it will operate on themes."})
    }
    const paras = getParas(entries[0])
    response = (await Promise.all(paras.map(async (p, i) => {
      const completion_ = await completion({
        prompt: prompt.replace("<paragraphs>", p),
      })
      return `Paragraph ${i}: ${completion_}`
    }))).join('\n\n')
  } else {
    const texts = placeholder.summary ? entries.map(getSummary) : entries.map(getText)
    const text = texts.join('\n')
    response = await completion({
      // entry v summary handled above, so just replace either/or here
      prompt: prompt.replace("<entry>", text)
        .replace("<summary>", text)
    })
  }

  return [{
    id: ulid(),
    view: req.view,
    response
  }]
})
