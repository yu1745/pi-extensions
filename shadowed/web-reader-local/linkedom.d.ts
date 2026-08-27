/** Override linkedom types to avoid conflicts with DOM lib. */
declare module "linkedom" {
  interface ParseHTMLResult {
    document: Document;
    window: Window & typeof globalThis;
  }
  export function parseHTML(html: string, options?: Record<string, unknown>): ParseHTMLResult;
}
