/** New Gmail names are flat English names; existing legacy names remain readable. */
import { Label_Problem } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { el } from '../dom.ts'

export const LABEL_NAME_HINT = "使用英文名称，最多 40 个字符；可含数字、空格及 &'().,+_-，不能用 / 分层"

export function labelNameProblem(value: string): string | null {
  if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return LABEL_NAME_HINT
  const name = value.trim()
  return name.length >= 1 && name.length <= 40 && /[A-Za-z]/.test(name) && /^[A-Za-z0-9 &'().,+_-]+$/.test(name) ? null : LABEL_NAME_HINT
}

export function labelNameInput(value: string, label: string): HTMLInputElement {
  return el('input', { value, maxlength: '40', 'aria-label': label, title: LABEL_NAME_HINT, placeholder: '英文名称，如 Travel', autocomplete: 'off', spellcheck: 'false' })
}

/** A stored legacy or hierarchical Gmail name needs an explicit owner repair. */
export const LABEL_PROBLEMS: Readonly<Partial<Record<Label_Problem, string>>> = {
  [Label_Problem.INVALID_NAME]: '名称不符合英文单层规则，暂不写入；请改名或到设置整理标签',
  [Label_Problem.HAS_CHILDREN]: 'Gmail 中含子标签，暂不写入；请整理为单层标签后同步',
}
