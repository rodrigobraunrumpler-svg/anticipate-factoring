/**
 * APIs de plataforma que usa el código de `shared`. `tsconfig.src.json` compila `src` sin tipos de
 * Node ni del DOM (`types: []`, `lib: ["ES2022"]`) para que el compilador rechace cualquier API que
 * no exista a la vez en Node, el navegador y los Workers; lo que sí existe en los tres se declara
 * aquí, con lo mínimo que se usa. `tsconfig.json` (editor y tests, con tipos de Node) excluye este
 * archivo: sus declaraciones chocarían con las de Node.
 */

/** Subconjunto de `TextDecoder` (WHATWG Encoding) que usa `decodeXml`. */
interface SharedTextDecoder {
  readonly encoding: string
  readonly fatal: boolean
  decode(input?: Uint8Array): string
}

declare const TextDecoder: {
  prototype: SharedTextDecoder
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): SharedTextDecoder
}
