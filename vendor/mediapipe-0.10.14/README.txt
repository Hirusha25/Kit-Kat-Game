MediaPipe Tasks Vision 0.10.14 and the Hand Landmarker model (float16, v1), both by Google, Apache License 2.0.
Used by js/hand-worker.js for the hand backup of the mug tracker. Runs on the kiosk only; no picture leaves the device.
vision_bundle.js is vision_bundle.mjs from npm with its export statement replaced by self.MPVision = {...}.
Sources: https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.14 and
https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
