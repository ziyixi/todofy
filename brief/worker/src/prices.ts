/** A rough token count of a prompt: a CJK character about one token, other text about four characters a token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3.5);
}
