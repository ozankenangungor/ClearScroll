/** Build-time capability. Source tests retain the complete private-alpha pipeline. */
declare const __CLEARSCROLL_IMAGES__: boolean;
export const IMAGES_AVAILABLE = typeof __CLEARSCROLL_IMAGES__ === "undefined" ? true : __CLEARSCROLL_IMAGES__;
