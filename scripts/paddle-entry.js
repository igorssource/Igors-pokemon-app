// Texterkennung PaddleOCR (PP-OCRv4) über ONNX Runtime – gebaut mit scripts in der README.
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

export async function createPaddle(base) {
  ort.env.wasm.wasmPaths = base;
  ort.env.wasm.numThreads = 1;
  return Ocr.create({
    models: {
      detectionPath: base + 'ch_PP-OCRv4_det_infer.onnx',
      recognitionPath: base + 'ch_PP-OCRv4_rec_infer.onnx',
      dictionaryPath: base + 'ppocr_keys_v1.txt',
    },
  });
}
