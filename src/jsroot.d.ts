declare module 'jsroot/io' { export const openFile: (path: string) => Promise<any>, addUserStreamer: (type: string, streamer: (buf: any, obj: any) => void) => void }
declare module 'jsroot/tree' { export const TSelector: any, treeProcess: (tree: any, selector: any) => Promise<any> }
declare module 'jsroot/rntuple' { export const readHeaderFooter: (tuple: any) => Promise<any>, rntupleProcess: (tuple: any, selector: any) => Promise<any> }
