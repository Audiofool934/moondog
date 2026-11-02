// The official sources Moondog's one-click setup downloads Stable Audio 3 from, each pinned to
// the release, commit or snapshot tested with Moondog on Apple silicon, and the files every
// download is verified against. Nothing here is fetched until the listener asks for a model.

// The models a listener can choose, with the flags sa3_mlx.py takes and the weights text to music
// loads. The codec encoder is only for --init-audio, so it is never downloaded.
export const STABLE_AUDIO_MODELS = Object.freeze({
  medium: Object.freeze({ dit: "medium", decoder: "same-l", receipt: "sa3-medium-ARC", weights: Object.freeze(["dit_medium_f16.npz", "same_l_decoder_f32.npz"]) }),
  "small-music": Object.freeze({ dit: "sm-music", decoder: "same-s", receipt: "sa3-sm-music-ARC", weights: Object.freeze(["dit_sm-music_f16.npz", "same_s_decoder_f32.npz"]) }),
});
export const DEFAULT_STABLE_AUDIO_MODEL = "medium";
// The text encoder every model needs.
export const SHARED_WEIGHTS = Object.freeze(["t5gemma_f16.npz"]);
export const isStableAudioModel = (value) => typeof value === "string" && Object.hasOwn(STABLE_AUDIO_MODELS, value);

const HF_SNAPSHOT = "08b17423649b5714b22eab20f96bf00751f2358a";
const CODE_COMMIT = "77e0398c26f7d22d801ec1bb036307e8b231f741";

export const STABLE_AUDIO_SOURCES = Object.freeze({
  // uv makes the Python environment, so the listener installs nothing.
  uv: Object.freeze({
    version: "0.9.7",
    url: "https://github.com/astral-sh/uv/releases/download/0.9.7/uv-aarch64-apple-darwin.tar.gz",
    size: 18_372_336,
    sha256: "35572b9619fc14d67fc1cd72582c3cfc5c9c66d97f310192e04f26fb3fe96005",
  }),
  // Stability AI's code (MIT). A GitHub tarball's bytes may change between downloads, so each file
  // extracted is checked against this manifest instead: [path in optimized/mlx, bytes, sha256].
  code: Object.freeze({
    commit: CODE_COMMIT,
    url: `https://codeload.github.com/Stability-AI/stable-audio-3/tar.gz/${CODE_COMMIT}`,
    folder: `stable-audio-3-${CODE_COMMIT}/optimized/mlx`,
    files: Object.freeze([
      [".gitignore", 420, "0dbc69aa372ac835f6ec00d4d18941443993b9d357722e6775857544eb0b4fa3"],
      ["README.md", 20260, "5fce0300becfed583577b0e0afacf6f68696196cd6597f136a455b17269e5c31"],
      ["TRAINING_CONVENTIONS.md", 14933, "3e915aefada47d3c56dc53f0fafd8ba274df0213b3cd6fb0d986e10420c1c727"],
      ["ableton/AudioInserter/AudioInserter.py", 5573, "9f318c73c8f4b81f15adb9d853334c9e6f8411e907044fb8c933e5c1fa98ef20"],
      ["ableton/AudioInserter/__init__.py", 112, "8530d242ecf41046d7e88b3e3aed707e2faa039db33630769dcfcdc297aa046c"],
      ["ableton/README.md", 2095, "2372e71f8e5fc05d8c4c3d609388e8a3a7390901d1af27eb897a018d8c29720c"],
      ["ableton/insert_audio.py", 7718, "439ec109d31c35c4da488e43b8593c315f2a0925d712538e0e813a5e565fd68d"],
      ["benchmark.sh", 1515, "1ca7b070f6272b3814214025d3d33849d3f0c12f2cf42ee830c2a3ea82db1aa5"],
      ["bootstrap.sh", 8812, "d05fa7f5849de1f2f8a31462e4bba174d3fdddcbd7ecd4bbbff3c0bc12199b44"],
      ["install.sh", 6509, "ca6b0af0325a9f6f43b5f2e6aec19fcba82e035b4dc55c74600fc43c38c027ec"],
      ["models/__init__.py", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["models/defs/__init__.py", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["models/defs/audio_encoding.py", 9380, "f31aa0026d5292adfa6eab288d076747fd04200d829de2defdc751a974d0d784"],
      ["models/defs/demo_mlx.py", 12751, "dfa7ec9ec4820538e95913a51409da060b7202ffee30eb2ac993acc335d305df"],
      ["models/defs/dit_mlx.py", 13470, "7a57f7140c1c2ecde477c1029770f05adf1b77f8dd876a1231c5255da509e75a"],
      ["models/defs/dit_mlx_medium.py", 17685, "12f4e0743f0c00f010f7e6b962e1de921378d1f4b3a3b77e6f106ece15e3ee4a"],
      ["models/defs/latent_dataset.py", 14908, "8be23c873273f42167069321fd69751e33187bd779669d2c2e75a2b1a17f7177"],
      ["models/defs/lora.py", 52582, "85464d21291d8ba8d9b1d281260ededc926d7fe91271945c7611cdef46fb30a0"],
      ["models/defs/lora_merge.py", 40136, "5a1738c078b088b367c24d7d7c12ab3a99b09e5c703ac9a5c343b5de4c121758"],
      ["models/defs/sa3_pipeline.py", 10775, "e8aca5225eeda40e1d3f53c04968bbce9df6290021f4bdc5c1a67d6d68013de8"],
      ["models/defs/same_l_decoder.py", 12795, "c9c4922169423407ee6acbf6e7c88a46761d75cacecdac4de24d4a484e762622"],
      ["models/defs/same_l_encoder.py", 5720, "71338711802fb5c7aaf15fea3852110c0a828cdbe94c643c553d4332944c5722"],
      ["models/defs/same_s_decoder.py", 11002, "2733dc254a67c133489108616652f353aec21566e900169b15d8d871ec57c88c"],
      ["models/defs/same_s_encoder.py", 7168, "d6785bb4ed549158d7dd2a3a13b85c2ec9cccf7f6ff05e9af58120ebbfd3e1df"],
      ["models/defs/t5gemma_mlx.py", 13913, "ec8f9c088c72174c75aabf9e54ce410d53ff306244ccd397657ac961683a11e3"],
      ["models/defs/training.py", 7674, "9bf99e2019fab90d75dd8caac8988e4ae723e3bc47fca137cab56025d705faa8"],
      ["requirements-gradio.txt", 170, "f1f4a2b95c58fc80b7881e7ee9bee98f9e565f2be58ccee63d53d5e4a8ccb896"],
      ["requirements.txt", 547, "c173edcf798d31b2b4c9dc919e439de3dc7c915d82a3f4255b62a4dae516b8ad"],
      ["sa3", 3108, "ff5411de89df7fdb986419ec441d57f0dd9856f89821aef48f8fd21fe1f1656b"],
      ["sa3-gradio", 1247, "86cf132971ee880892cf68687201a0f2a3d3e9ed8fbb4c5d6c61a7d433cc8aa7"],
      ["scripts/benchmark.py", 7201, "91c76adbfba3dadfb80fd32a3bd751be95a2b01f02a7939d3d849cbc70086715"],
      ["scripts/examples.py", 6672, "011f05d5a690b2f46a7b8a0b898a4d94aa130205a121d12dfbdd18c6c8506213"],
      ["scripts/export_base_npz.py", 4108, "0ef788a8ef9c679d2e8b8bb18ded0a2f775c7781df84d4dd73542971f46f62b1"],
      ["scripts/install.py", 6082, "7f629fccec01fd88ae159bae3495299f04be205733916851ea5b0138d851a1a8"],
      ["scripts/lora_train_mlx.py", 49794, "e5d87e10e122ff4a054ac7f0d261650830e5d77b7a9fa2a07a14452db4cfae60"],
      ["scripts/parity_forward_mlx.py", 4918, "a736a3a29ea0dcccf36543e8e9f63c38b1c1bef670a51c67915b7473c665e8f1"],
      ["scripts/parity_forward_torch.py", 5236, "54db7fca02a5ce618417ee52ec54d3d291d866ff67762e4fc2e95371f9af201b"],
      ["scripts/pre_encode_mlx.py", 15985, "f6e4a2c7bcec19b0e9fc4316ee31b2277663a7dc0e569eb76400b44457686729"],
      ["scripts/sa3_gradio.py", 69093, "72c6eafa087dd309151cc4524c93a9281c3f3bdde9580a5578458bce047a59fd"],
      ["scripts/sa3_mlx.py", 45778, "312c2833fac5ca270cbeebe7037b3fbeacd87b10c9b5d057587c5eaf824fb951"],
      ["scripts/spec.py", 6574, "3e85ee7850a4e3861733823c1c712a123550c48c1cbd47cbb0e0baea2f31b42d"],
      ["scripts/test_all_configs.py", 9969, "db210dfb7297c640feaede146a9538b1da6ea167436c04f8921c741f472d37de"],
      ["scripts/test_lora_merge.py", 20704, "efd88ade4205e53bf938135853e2c9cd53a61cccc844bc6f17dfb77409c8d36f"],
      ["scripts/weights.py", 7303, "9b367084a8cfa6dffa090bf39e84f850981f689e43aab78112787fdcb3d16bf0"],
    ]),
  }),
  // The Python and the packages that run on the Mac it was tested on; Pillow is only for training.
  python: Object.freeze({
    version: "3.11.14",
    packages: Object.freeze([
      "anyio==4.15.1", "cffi==2.1.1", "click==8.5.0", "filelock==4.2.4", "fsspec==2026.9.0", "h11==0.16.0",
      "hf-xet==1.7.0", "httpcore2==2.16.0", "httpx2==2.16.0", "huggingface-hub==2.3.0", "idna==3.20",
      "mlx==0.32.4", "mlx-metal==0.32.4", "numpy==2.4.6", "packaging==26.3", "pycparser==3.12", "pyyaml==6.0.3",
      "sentencepiece==0.2.2", "soundfile==0.14.0", "tqdm==4.70.1", "truststore==0.10.5", "typing-extensions==4.16.0",
    ]),
  }),
  // Stability AI's weights (Stability AI Community License; T5Gemma under the Gemma Terms of Use).
  weights: Object.freeze({
    url: (name) => `https://huggingface.co/stabilityai/stable-audio-3-optimized/resolve/${HF_SNAPSHOT}/MLX/${name}`,
    files: Object.freeze({
      "t5gemma_f16.npz": Object.freeze({ size: 567_443_068, sha256: "8deb20489f36d9aec539f26c9c67321f99bc5fe300d470435ed6e76be4f16bbd" }),
      "dit_medium_f16.npz": Object.freeze({ size: 2_907_300_946, sha256: "f9e5647ea3225818657d47d47ae4b34afa29c0568206ca89566c1a758944a38e" }),
      "same_l_decoder_f32.npz": Object.freeze({ size: 1_704_311_976, sha256: "84924be2122d3a20fce443f40b782d9cd88e8e73707476326003ac47659a2287" }),
      "dit_sm-music_f16.npz": Object.freeze({ size: 919_193_814, sha256: "8ed3f38e2597f361ee675051f1265d9aa2ae2fffce1c61acd2e9fe31e1db1cbc" }),
      "same_s_decoder_f32.npz": Object.freeze({ size: 218_090_820, sha256: "909928a8e6937c1ebe6ac4b729f0462bd3773704a11ea18278e42671dc69bfe4" }),
    }),
  }),
  // What the listener agrees to before the first download.
  licenses: Object.freeze([
    Object.freeze({ id: "stability-ai-community", name: "Stability AI Community License", url: "https://stability.ai/license" }),
    Object.freeze({ id: "gemma-terms", name: "Gemma Terms of Use", url: "https://huggingface.co/stabilityai/stable-audio-3-optimized/blob/main/LICENSE_GEMMA.md" }),
  ]),
});
