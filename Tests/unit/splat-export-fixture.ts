// Test entry for Gaussian splats (Runtime/src/splatStandIn.ts): the exporter, the renderer state it reads and the
// splat stand-ins come from one bundle, so a test can export a frame and look at the stand-in it drew.
export {lastFrame} from '../../Runtime/src/renderer';
export {exportFrame, INSTANCED, HEADER_FLOATS} from '../../Runtime/src/sceneExport';
export {splatStandIns, splatFrame, isSplatRenderer, packedSplatsOf} from '../../Runtime/src/splatStandIn';
export {splatMaterial, SPLAT_VERTEX, SPLAT_FRAGMENT} from '../../Runtime/src/splatShader';
