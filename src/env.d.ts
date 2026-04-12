/// <reference types="@rsbuild/core/types" />

declare module "*.glsl?raw" {
  const source: string;
  export default source;
}

declare module "*.glsl" {
  const source: string;
  export default source;
}
