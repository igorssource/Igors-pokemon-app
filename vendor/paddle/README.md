# PaddleOCR im Browser

Liest die kleine Kartennummer deutlich zuverlässiger als Tesseract.

- `paddle.js`: gebündelt aus `@gutenye/ocr-browser` 1.4.9 (MIT) und `onnxruntime-web` 1.30.0 (MIT, nur WebAssembly-Teil)
- `ort-wasm-simd-threaded.wasm`: ONNX Runtime (MIT)
- `ch_PP-OCRv4_det_infer.onnx`, `ch_PP-OCRv4_rec_infer.onnx`, `ppocr_keys_v1.txt`: PaddleOCR PP-OCRv4 (Apache-2.0), aus `@gutenye/ocr-models` 1.4.2
- OpenCV wird nicht mitgebündelt, sondern aus `vendor/opencv` verwendet (`scripts/cv-shim.js`)

Neu bauen:

```
npm i @gutenye/ocr-browser@1.4.9 esbuild
npx esbuild scripts/paddle-entry.js --bundle --format=esm --minify --outfile=vendor/paddle/paddle.js \
  --external:path --external:fs --external:url \
  --alias:@techstark/opencv-js=./scripts/cv-shim.js \
  --alias:onnxruntime-web=./node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs --legal-comments=eof
```
