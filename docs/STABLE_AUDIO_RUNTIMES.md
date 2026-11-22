# Stable Audio 3 beyond Apple silicon

This note records which ways exist to run Stable Audio 3 on each machine Moondog ships to, what was verified on real hardware, and the order of work.
The CPU tests on 2026-11-21 and NVIDIA tests on 2026-11-22 used `Stability-AI/stable-audio-3` at 790793b (2026-11-02) and the Hugging Face repository `stabilityai/stable-audio-3-optimized` at 30cb264 (2026-10-30).

## What Moondog runs now

- A Mac with Apple silicon runs Stability AI's MLX build on the GPU, as before.
- Windows on x64, Linux on x64 and Linux on ARM run Stability AI's LiteRT build ("tflite") on the CPU.
- Both builds come from Stability AI's own repository and Hugging Face snapshot, pinned in `src/integrations/stable-audio/sources.mjs`, and each file is checked before it runs.
- The listener chooses Medium or Small Music in both builds.
- On the CPU, both models use Stability's defaults: int8 (w8a8) models and the SAME-S decoder.
- Small Music on the CPU stops at 120 s, so a longer request makes a 120 s track.
- An Intel Mac still has no build: LiteRT publishes no macOS x64 wheel, and MLX needs Apple silicon.

## Paths by machine

| Machine | Path | Status | Verified |
| --- | --- | --- | --- |
| Mac, Apple silicon | MLX (official) | In Moondog since 0.3.0 | Yes, M6 and M2 Pro |
| Windows x64, any GPU or none | LiteRT CPU (official) | In Moondog with this change | Yes, GitHub runner (4 vCPU) |
| Linux x64, any GPU or none | LiteRT CPU (official) | In Moondog with this change | Yes, GitHub runner (4 vCPU) |
| Linux ARM | LiteRT CPU (official) | In Moondog with this change | Yes, GitHub runner (4 vCPU) |
| Linux x64, NVIDIA | TensorRT (official) | Not wired | No |
| Linux x64, NVIDIA | PyTorch package with CUDA (official) | Standalone only | Yes, A800, both models |
| Windows x64, NVIDIA | PyTorch package with CUDA | Undocumented upstream | No |
| Windows x64, NVIDIA, AMD or Intel GPU | sa3.cpp with CUDA or Vulkan (community) | Not wired | No |
| Windows x64, any DirectX 12 GPU | DirectML (community pull request #122) | Not merged upstream | No |
| Linux x64, AMD GPU | sa3.cpp with Vulkan or HIP (community) | Not wired | No |
| Linux x64, Intel Xeon with AMX | cpu-amx (pull request #105) | Not merged upstream | No |
| Windows on ARM | LiteRT CPU | Wheels since LiteRT 2.4.0 (2026-11-20) | No |
| Mac, Intel | sa3.cpp universal build (community) | Not wired | No |

### LiteRT CPU build (official, in Moondog)

- Source: `optimized/tflite` in Stability AI's repository, MIT.
- Weights: `tflite/` on Hugging Face, ungated, under the Stability AI Community License; T5Gemma under the Gemma Terms of Use.
- Install: uv, Python 3.11.14, `ai-edge-litert` 2.3.0 and its dependencies, about 75 MB of Python packages.
- Download sizes: Small Music 1.2 GB, Medium 2.3 GB, with the text encoder and decoder shared.
- On first use the build writes a weight cache (`.xnnwc`) beside each model file, at most about the file's own size.
  Moondog keeps room for it and removes it with its model.
- Speed on a Mac mini M6 CPU (12 cores, 8 threads), measured with Stability's script:

| Model | Length | Time | Peak memory |
| --- | --- | --- | --- |
| Small Music | 120 s | 9.7 s | 2.2 GB |
| Medium, SAME-S | 120 s | 29 s | 2.5 GB |
| Medium, SAME-L | 120 s | 38 s | 2.6 GB |
| Medium, SAME-S | 380 s | 132 s | 5.2 GB |

- The first track of a model takes longer, because it writes the weight cache (16 s instead of 9 s for Small Music).
- Speed on GitHub's hosted runners (4 vCPU, 16 GB), through Moondog's own setup and generator, for a 120 s track (second run of each):

| Runner | CPU | Small Music | Medium |
| --- | --- | --- | --- |
| Windows x64 | AMD EPYC 7763 | 72 s | 247 s |
| Linux x64 | Intel Xeon Platinum 8573C | 28 s | 103 s |
| Linux ARM | Arm, model not reported | 23 s | 80 s |

- Small Music makes music faster than it plays on every runner.
  Medium is slower than real time on the Windows runner, whose two physical cores have no int8 dot-product instructions; a listener's stream with Medium on such a machine waits between tracks.
- A desktop or laptop with more cores is faster; none was measured.

### TensorRT (official, Linux and NVIDIA only)

- `optimized/tensorRT` stops on any OS but Linux.
- Prebuilt engines on Hugging Face exist only for `sm_90` (H100, H200) and `sm_120` (RTX 50 series).
  The `sm_120` folder has only legacy SAME engines, which the runtime no longer loads.
- The installer selects a local engine build on other architectures, including the A800 (compute capability 8.0).
- The pinned builder requests `onnx/same-l/dec_fp16_chunkable_limiter.onnx` for Medium and `onnx/same-s/dec_bf16_chunkable_limiter.onnx` for Small Music.
  Both paths returned HTTP 404 on the A800 host.
  The published Small Music decoder path, `onnx/same-s/dec_bf16_limiter.onnx`, resolved on the same snapshot.
  The stock build therefore lacks a required input for each model.
  TensorRT generation on this card remains unverified.
- It pins one exact TensorRT 10.15.1 build on CUDA 13, and engines do not load across TensorRT versions. NVIDIA says engines are not portable between Linux and Windows.
- It is the fastest path: Stability reports 0.13 s for 120 s of Medium on an H200.

### PyTorch package (official, NVIDIA)

- The repository root installs PyTorch 2.7.1 built for CUDA 12.6, on Linux x64 only by its own index rules.
- The Medium, Small Music and Small SFX checkpoints are gated on Hugging Face: a download needs a token and accepted terms.
- The README says Medium needs Flash Attention 2.
  The code falls back to PyTorch's own attention without it, but the README blames "static glitch" output on its absence.
- Windows is not documented. A community one-click installer (upstream issue #56) runs on Windows with NVIDIA, through `stable-audio-tools` rather than this package.
- There is no ROCm, Intel XPU or DirectML code.

#### Linux A800 measurements

The official Python package generated 30 s and 120 s tracks on an NVIDIA A800-SXM4-80GB with Python 3.10, PyTorch 2.7.1+cu126 and driver 580.65.06.
The two model checkpoints and the shared T5Gemma encoder matched the SHA-256 digests published by Stability AI.
Each run used one GPU, one instrumental piano prompt, the default eight steps and batch size one.

| Model | Attention | 30 s track | 120 s track | Peak CUDA memory |
| --- | --- | ---: | ---: | ---: |
| Small Music | PyTorch fallback | 0.39 s | 0.46 s | 1.79 GiB |
| Small Music | Flash Attention 2.8.3 | 0.49 s | 0.57 s | 1.79 GiB |
| Medium | PyTorch fallback | 1.21 s | 3.04 s | 6.50 GiB |
| Medium | Flash Attention 2.8.3 | 0.76 s | 0.97 s | 5.17 GiB |

Times are the mean of the second and third generations at each length, synchronized on the GPU, before writing the WAV.
Loading a model from local weights took 14 to 29 s.
The first 30 s generation took another 2.7 to 3.2 s with Flash Attention and 19 to 28 s with the fallback.
Peak memory is the largest allocation total reported by PyTorch during generation.
All 24 outputs had finite, non-silent stereo samples at 44.1 kHz and the requested length.
Audio quality was not listening-tested.
The measurements cover the upstream Python package on Linux.
Moondog's Linux installer still selects the CPU runtime.

### sa3.cpp (community, many GPUs)

- `betweentwomidnights/sa3.cpp` is a ggml port, MIT, with CUDA, Vulkan, Metal, HIP and CPU backends and a C ABI.
- Its releases (prereleases, v0.2.4 on 2026-11-17) ship Windows x64 CUDA (164 MB) and Vulkan (12 MB) builds, Linux x64 and ARM Vulkan builds, and a macOS universal build.
- Its weights are GGUF conversions on Hugging Face (`thepatch/stable-audio-3-medium-GGUF`, ungated), in F32, F16 and Q8 to Q4 quantizations, made by the same author.
- Its notes report Vulkan on an RTX 5070 laptop and an AMD 780M, and HIP as untested; the newest release says Vulkan is not yet validated.
- It is the only path found that reaches AMD and Intel GPUs on Windows and Linux.
- It is not a Stability AI source. Moondog downloads only official sources today, so using it is the project owner's decision.

### DirectML (community pull request #122)

- An open pull request adds `optimized/directml`: ONNX Runtime with DirectML on any DirectX 12 GPU on Windows.
- It was tested on one AMD Radeon RX 7600 (8 GB): 30 s of Medium in 18-19 s, 380 s in 71 s.
- It has no review, no CI, and fetches one tokenizer file from a gated repository.
- Microsoft keeps DirectML in maintenance mode, and `onnxruntime-directml` stopped at 1.24.4.

### cpu-amx (pull request #105)

- A C++ runtime for Intel Xeon CPUs with AMX (4th and 5th generation), Linux x64 only, Medium only.
- It is open and unreviewed upstream, and its own notes say it is not faster than fp32 without AMX.
- Desktop and laptop CPUs have no AMX, so it does not help Moondog's listeners.

### ONNX files

- The DiT, T5Gemma and SAME-S ONNX files use standard operators.
- The SAME-L ONNX files use a TensorRT plugin (`samel::diff_attn_swa`), so they do not run in plain ONNX Runtime.
- Nobody has reported testing them with ONNX Runtime's CUDA or MIGraphX providers.

## Licenses

- Stability AI's code in every official runtime is MIT.
- The weights are under the Stability AI Community License; T5Gemma is under the Gemma Terms of Use. Moondog asks the listener once before the first download, on every machine.
- Generated music belongs to the listener.

## Order of work

1. LiteRT CPU build on Windows and Linux (this change).
   It is the only official path on Windows, it runs on every Windows and Linux computer whatever the GPU, and it could be verified on real hardware.
   Its setup work (uv per machine, Windows paths and processes, a build per machine) is what each later runtime needs too.
2. NVIDIA on Linux with the official PyTorch package or TensorRT.
   PyTorch with Flash Attention is the first verified GPU candidate for Medium on the A800.
   Integrating it requires a way to download the gated weights and install a matching CUDA and Flash Attention build.
   Other NVIDIA cards still need hardware checks.
   TensorRT needs compatible engine files for each GPU architecture.
3. A GPU path on Windows, for NVIDIA, AMD and Intel.
   sa3.cpp (CUDA and Vulkan) is the strongest candidate, and the DirectML pull request is the other; both are community code, so the owner decides first.
4. Windows on ARM with LiteRT 2.4.0, once Moondog ships an ARM Windows build.
   Until then, Windows on ARM runs the x64 app and the x64 CPU build under emulation, which was not tested.

## CI check

`.github/workflows/stable-audio-cpu.yml` sets up both models the way a listener's download does and makes two 120 s tracks with each, on Windows x64, Linux x64 and Linux ARM.
It runs when the Stable Audio integration changes, or by hand, and keeps the tracks as an artifact for 14 days.
