/** jsdom ships no type declarations; the parity test only needs the constructor and the document. */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html: string);
    readonly window: { readonly document: Document };
  }
}
