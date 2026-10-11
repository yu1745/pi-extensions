// 机械规则只提供证据；不确定的页面仍交给 Decisions 的页面裁决。
export const CONSENT_SELECTORS = ['#CybotCookiebotDialog', '#CybotCookiebotDialogDetail', '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk', '#didomi-host', '#usercentrics-root', '.qc-cmp2-container', '.cookie-banner', '.cookie-consent', '.cookie-settings']
export const CONSENT_WORDS = /cookies?|cookiebot|隐私设置|隐私偏好/i
export const CONSENT_ACTIONS = /accept|reject|consent|necessary|preferences|settings|同意|拒绝|必要|设置/i

export const GATE_PATTERNS = [
  ['content_gate', /(?:content|game|page) (?:you have asked|you(?:'ve| have) chosen|you have requested) (?:not to see|to (?:block|exclude))|该(?:游戏|页面|内容)包含您要求屏蔽的内容|(?:verify|confirm) your age|(?:enter|provide) your (?:date of birth|birth date)|请(?:确认|验证)您的年龄/i],
  ['bot_check', /just a moment|checking your browser|verify you are human|attention required|access denied|captcha|请稍候|正在验证|人机验证|安全验证|访问被拒绝/i],
  ['login_wall', /(?:sign in|log in|subscribe|register) to (?:continue|read|view|access)|(?:登录|订阅|注册)后(?:才可|即可|才能)?(?:阅读|查看|访问)/i],
] as const

export function gateSignal(text: string) {
  for (const [kind, pattern] of GATE_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return { kind, index: match.index }
  }
  return undefined
}

/** 门槛提示可能排在数千字的语言菜单之后；不能只把页面开头交给裁决。 */
export function pageExcerpt(text: string, limit = 500): string {
  const normalized = text.replace(/\s+/g, ' ')
  const gate = gateSignal(normalized)
  const start = gate ? Math.max(0, gate.index - 80) : 0
  return normalized.slice(start, start + limit)
}
