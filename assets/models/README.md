# Models

## people.onnx

Finds the people a tracked camera sees, for the layers anchored behind them
(Designer › layer › Tracking › Behind the people).

- Model: MediaPipe Selfie Segmentation, landscape (256 × 144 RGB in, one
  person mask out), by Google.
- Source: `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite`
- Licence: Apache License 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>).
- Changes: converted from TFLite to ONNX (opset 14) with tflite2onnx, adding
  the HardSwish activation and MediaPipe's `Convolution2DTransposeBias`
  operator as ONNX `ConvTranspose` with its bias. Its masks match the
  original's to within 0.0001.

Input: `input_1`, 1 × 3 × 144 × 256, RGB from 0 to 1.
Output: `segment_back`, 1 × 1 × 144 × 256, how much each point is a person (0 to 1).
