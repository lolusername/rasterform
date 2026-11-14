/// <reference types="vite/client" />

interface QueryLocalFontsOptions {
  postscriptNames?: string[]
}

interface FontData {
  readonly family: string
  readonly fullName: string
  readonly postscriptName: string
  readonly style: string
  blob(): Promise<Blob>
}

interface Window {
  queryLocalFonts?: (options?: QueryLocalFontsOptions) => Promise<FontData[]>
}

interface FontFaceSet {
  add(font: FontFace): this
  delete(font: FontFace): boolean
}

declare module 'three/examples/jsm/loaders/HDRLoader.js' {
  export { RGBELoader as HDRLoader } from 'three/examples/jsm/loaders/RGBELoader.js'
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
