// The official sources Moondog's one-click setup downloads Stable Audio 3 from, each pinned to
// the release, commit or snapshot tested with Moondog, and the files every download is verified
// against. Nothing here is fetched until the listener asks for a model.
//
// Two of Stability AI's runtimes make the music. MLX runs on the GPU of a Mac with Apple silicon.
// The LiteRT build ("tflite") runs on the CPU of Windows and Linux, x64, and of Linux on ARM; it
// is slower, and on a laptop CPU the small model makes music faster than it plays.

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

// The same two models in the CPU build, with the flags sa3_tflite.py takes and the weights under its
// models/tflite folder, at Stability's own defaults: int8 (w8a8) models and the small SAME-S decoder,
// which decodes Medium too and is about seven times faster than SAME-L on a CPU. The small models stop
// at two minutes.
export const STABLE_AUDIO_TFLITE_MODELS = Object.freeze({
  medium: Object.freeze({ dit: "medium", decoder: "same-s", precision: "w8a8", receipt: "sa3-medium-ARC", maxSeconds: 380, weights: Object.freeze(["sa3-m/dit_w8a8.tflite"]) }),
  "small-music": Object.freeze({ dit: "sm-music", decoder: "same-s", precision: "w8a8", receipt: "sa3-sm-music-ARC", maxSeconds: 120, weights: Object.freeze(["sa3-sm-music/dit_w8a8.tflite"]) }),
});
// The text encoder and the decoder both models use.
export const TFLITE_SHARED_WEIGHTS = Object.freeze(["t5gemma/encoder_fp16.tflite", "same-s/dec_w8a8.tflite"]);

/**
 * The runtime that makes music on this machine: "mlx" on a Mac with Apple silicon, "tflite" on the CPU of
 * Windows and Linux (x64) and Linux on ARM, or null where no Stability AI build runs (an Intel Mac).
 * MOONDOG_SA3_RUNTIME=tflite tries the CPU build on an Apple silicon Mac, for development.
 */
export function stableAudioRuntime({ platform = process.platform, arch = process.arch, environment = process.env } = {}) {
  if (platform === "darwin" && arch === "arm64") return environment?.MOONDOG_SA3_RUNTIME === "tflite" ? "tflite" : "mlx";
  return ["win32-x64", "linux-x64", "linux-arm64"].includes(`${platform}-${arch}`) ? "tflite" : null;
}

/** A runtime's models, the weights all of them share, and the folder its weights sit in. */
export function stableAudioRuntimeModels(runtime) {
  return runtime === "tflite"
    ? { models: STABLE_AUDIO_TFLITE_MODELS, shared: TFLITE_SHARED_WEIGHTS, weightsFolder: ["models", "tflite"], script: "sa3_tflite.py" }
    : { models: STABLE_AUDIO_MODELS, shared: SHARED_WEIGHTS, weightsFolder: ["models", "mlx"], script: "sa3_mlx.py" };
}

/** The longest track a model makes, in seconds, on a runtime. */
export const stableAudioMaxSeconds = (runtime, model) => stableAudioRuntimeModels(runtime).models[model]?.maxSeconds ?? 380;

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

// uv for each machine the CPU build runs on (the Mac's is above). Windows' zip holds uv.exe at its top.
const UV_RELEASE = "https://github.com/astral-sh/uv/releases/download/0.9.7";
const UV_BUILDS = Object.freeze({
  "darwin-arm64": STABLE_AUDIO_SOURCES.uv,
  "win32-x64": Object.freeze({ version: "0.9.7", url: `${UV_RELEASE}/uv-x86_64-pc-windows-msvc.zip`, size: 20_800_451,
    sha256: "5d250c32d3604e28dbe18dc65c668ff628c53e00dde2c642576e831e4a60da64", strip: 0 }),
  "linux-x64": Object.freeze({ version: "0.9.7", url: `${UV_RELEASE}/uv-x86_64-unknown-linux-gnu.tar.gz`, size: 21_420_448,
    sha256: "b26fcc8dfa1c39b5a5613445af3be3eefda45d9a39359bee271eafe34913583e" }),
  "linux-arm64": Object.freeze({ version: "0.9.7", url: `${UV_RELEASE}/uv-aarch64-unknown-linux-gnu.tar.gz`, size: 20_300_539,
    sha256: "8b3d31a154673c6d357727d2083a33525b515589d153fa5b5455e1db9e9e6363" }),
});

const TFLITE_HF_SNAPSHOT = "30cb2644da54bfa63275d1bc7f1fa67fc718680f";
const TFLITE_CODE_COMMIT = "790793b89ddceea612be9ce42ff6830d18f6fa57";

// Stability AI's CPU build (MIT), from the newest commit, which carries its fixes to the SAME-S codec, with
// the weights of the Hugging Face snapshot those fixes shipped in. The manifest lists the files as GitHub's
// tarball holds them: its .bat files have Windows line endings.
export const STABLE_AUDIO_TFLITE_SOURCES = Object.freeze({
  code: Object.freeze({
    commit: TFLITE_CODE_COMMIT,
    url: `https://codeload.github.com/Stability-AI/stable-audio-3/tar.gz/${TFLITE_CODE_COMMIT}`,
    folder: `stable-audio-3-${TFLITE_CODE_COMMIT}/optimized/tflite`,
    files: Object.freeze([
      [".gitattributes", 106, "913830f0563a4c672c0a3ffb1d2213dfdca8b0b29979d6fb84dab111f824d5e5"],
      [".gitignore", 562, "b50b199fa864581a0710277c7112f7734754f05cb32b63da6a27fd403a6aeac7"],
      ["README.md", 27139, "a5cde8d37f43d48f636d97717677becc4b0262c6f96acacaeaa989756af60a90"],
      ["bootstrap.ps1", 4310, "86199f02ebaf733c4cdd98787831bd2d1151fa4457b910d688b359dc765f0b93"],
      ["bootstrap.sh", 8106, "5b7657b5ae1adbcdcb29354dce86c6a4b977af0e74d7d7c92ea910a79ecb30c3"],
      ["build/README.md", 7061, "e9ab249dd0782f516562957caa58eddfb7af2b84838dae4a82ca974a0d527504"],
      ["build/build_all.sh", 5100, "dad6694252787f34f258f3e564248fc948bef8fc310f7370a62e28d06fd20c9d"],
      ["build/build_dit.sh", 4203, "f42786117d142369037951c5c9bf65fe6bdcbd61f6eacb3c641d36be9ed60fde"],
      ["build/build_dit_small.sh", 4294, "0a4e2138a2e4119c7a54f93a34d8e66c39fd2e225bc3468d4bff48600881319d"],
      ["build/build_paths.py", 1632, "5efcac6efb816c4b680fe8be7650b8030329a916ede91af87eb1dc47678402d3"],
      ["build/enc_rht.py", 4707, "48525621d547c47c8de30ff0c1e9d02bd552dd8e74875222d37432a8e1e56383"],
      ["build/export/export_dit.py", 20548, "a1c7e12746a534114602a48eda4d39ac379c9dd609daeaab443a88e7f890e2cf"],
      ["build/export/export_enc_windowed.py", 1435, "7f2653560c8dd66112a7b92659d18a586f20b25449292d5c43d390bbbed74557"],
      ["build/export/export_same_s_fixed.py", 1837, "2b67d29a339f8d15fe9721364e049856a25dbb30f1cfc1bb61e328d8aea75d6a"],
      ["build/export/export_windowed_param.py", 1645, "e0103a2b54fa196c17d2a2c3e902c452903cffc937dbfb5c3fa926e3beeb2579"],
      ["build/extract/extract_same_l_decoder_weights.py", 2986, "9c886a9d9c153b89cf55fc0c403ab83f6d6c7bf2171c1a60a626346073f85128"],
      ["build/extract/extract_same_l_encoder_weights.py", 3207, "59a537bd8c24c47b078e697fa9613fa295e0f6afa4beb4a6b8f1aa015c08f3f6"],
      ["build/extract/extract_same_s_decoder_weights.py", 2719, "ed8de0d3c7219421a160fbd76444dfd687a4658c0cb7b07bcab8350f58801eaf"],
      ["build/extract/extract_same_s_encoder_weights.py", 2852, "f595f5557a2162e31452ec523d8bb946e64216aa6a14af871884b081b2d07658"],
      ["build/quant_merge/merge_rungs_generic.py", 6804, "449e20200a436503950e0a6850339f7dbb9409199c3634702962f33c4345ac8c"],
      ["build/quant_merge/quant_one.py", 3163, "ff96622ada544925e181cf6fa60a5ed537a5b25806082f5c0e62189be923dd47"],
      ["build/tfl_surgery.py", 6301, "05305cf439b2f8d6154fc8cd4d306642738e2da569214e826ada436896ac44fa"],
      ["build/torch_defs/limiter.py", 3873, "52659fba64944be7bea52edf025fbd628d94e1630757f10797fc710f2c58996a"],
      ["build/torch_defs/same_l_decoder_torch.py", 11021, "f929cabc57137ff0f141280413296002355df8810004f2d65b698e8b8e61f9c4"],
      ["build/torch_defs/same_l_encoder_torch.py", 7483, "a5103af23083d825185f2e49a433d05a6210a4f0f2cd9d85f5d25b148aa5d9ee"],
      ["build/torch_defs/same_s_decoder_torch.py", 18086, "25f2920d297877aa41fae727ea9bf7e9462bc06e7beeff011e69771deb11b192"],
      ["build/torch_defs/same_s_encoder_torch.py", 5371, "b21d8ccbfe50ba83d119ca2c640f64a01217e21b6f067de72b01a8ba4caae727"],
      ["build/torch_defs/windowed_decoder.py", 3268, "3257219ac18e4e38631e4ba66c4dec51d5ca5a76af11224cbb9d51e0bf446f42"],
      ["build/verify_final.py", 2836, "2e779fb94295b9299328dc52a98e080ea775fb053cf496e58a013f3db1ef5e0f"],
      ["docs/RUNGS.md", 6376, "c4bd7aed3352f926738646924f9edcfc55628cace8a5e006d58c5af53788f321"],
      ["docs/img/dit-ram-rung-vs-varlen-small.png", 84406, "4eea47638de62b87f1d8a32e60eb7a6bde94a1ff6a960001963cb00116f600ae"],
      ["docs/img/dit-ram-rung-vs-varlen.png", 72229, "6b57d719628a2e64119b95abe3e2a36f2179aef309c5b96ca9fcd5079827dc7a"],
      ["install.bat", 1633, "35c16ffc134aba8264be39e8a9699d85a12e12431e9b5ea32a87009b18a7644c"],
      ["install.sh", 6085, "436409b5702f80767a554a033e55a30b26b3c44e0d3440d33004b183bb3573b1"],
      ["models/__init__.py", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["models/defs/__init__.py", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["models/defs/tflite_pipeline.py", 7053, "229f34424d8ace818e416a8a3e50b92b859a074af44f4d5ed29eddc845b30e64"],
      ["models/tflite/.gitkeep", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["models/tokenizer.model", 4241003, "61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2"],
      ["output/.gitkeep", 0, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["requirements-gradio.txt", 170, "f1f4a2b95c58fc80b7881e7ee9bee98f9e565f2be58ccee63d53d5e4a8ccb896"],
      ["requirements.txt", 150, "4f0a6bdfde92238996b6bd09bc067d3ae777dced99872ce16fe26b028aa85244"],
      ["sa3", 3144, "aac881529e5e253803c59b334c5af466ed2242c92c3d4a6ba2429c3dda134792"],
      ["sa3-gradio", 1267, "91a3a7f9304e969be2c40bf3d6c9740fbf1a0523b9367750afe6d8de0b010f8d"],
      ["sa3.bat", 808, "a02fb71cf35402d38d6f1b26e77b72071e886b1cdd33f0341a4e7e6d69471710"],
      ["sa3.ps1", 540, "37e76880dee628520234f801becf23892439c2d94a91d85caceda3610db5c010"],
      ["scripts/examples.py", 7696, "9a8d376357b3fcf5c79c38f43bbf5e565999f09c8b08bccd4b7d3a2979b6479d"],
      ["scripts/install.py", 6495, "86a2421ed034d4aa21e16e291741ae5cabd200fb84512f0706c7b94604c40fad"],
      ["scripts/lora_core.py", 13769, "7c27fbb6231517cd16c87cb07ba9ae3f1cbc6838e47093a840894380bcb88104"],
      ["scripts/lora_patch.py", 18363, "e302943921a7fa84681a96df68e4930ecd62477018c029aee03e1f7698ab688c"],
      ["scripts/rung_decoder.py", 6512, "c2e82c53e3189e0fc3a1f948c19d84b5016e90e9eddac6e27c9e2daa20c612e7"],
      ["scripts/rung_dit.py", 12790, "229531d9a6298094427def0aa2715814c0324ba0bde819cd77f7f8797168f061"],
      ["scripts/rung_encoder.py", 5561, "cbfa3ca9693f67fa3216f5d8143db82e7b963d54eeac0e99b2ebfb1d8570419a"],
      ["scripts/sa3_gradio.py", 67687, "ce7dcde67e1092a1ae1db0a270a4d3258169e6099cd2cf7e4d904bcd909434c8"],
      ["scripts/sa3_tflite.py", 49542, "6e7a993346d17740d6a43c9d9a061b0bc30ad37eed4a191e5fe16fdcdeb8b0e7"],
      ["scripts/spec.py", 6574, "3e85ee7850a4e3861733823c1c712a123550c48c1cbd47cbb0e0baea2f31b42d"],
      ["scripts/test_lora_patch.py", 14194, "f36de7afd8a19f7b48db5f1f5526c4b729d6dff294d7ed9ce7d5bb965204ac40"],
      ["scripts/test_windows_compat.py", 8345, "fc21b66730650ea476f26e61688e17aeaeff8ea293a9c5a3ffcc83a6820b7495"],
      ["scripts/weights.py", 12618, "24c783e2fc06aa34285120ad98eebd9ccb2ecce9f39ca776ca55eb028c772e33"],
    ]),
  }),
  // LiteRT and what it needs, the same pins on every machine (colorama only matters on Windows). The
  // script imports Hugging Face's client only to download a missing file, which Moondog never asks of it.
  python: Object.freeze({
    version: "3.11.14",
    packages: Object.freeze([
      "ai-edge-litert==2.3.0", "backports-strenum==1.3.1", "cffi==2.1.1", "colorama==0.4.6", "flatbuffers==25.12.19",
      "ml-dtypes==0.6.0", "numpy==2.4.6", "protobuf==7.36.2", "pycparser==3.12", "sentencepiece==0.2.3", "soundfile==0.14.0",
      "tqdm==4.70.1", "typing-extensions==4.16.0",
    ]),
  }),
  weights: Object.freeze({
    url: (name) => `https://huggingface.co/stabilityai/stable-audio-3-optimized/resolve/${TFLITE_HF_SNAPSHOT}/tflite/${name}`,
    files: Object.freeze({
      "t5gemma/encoder_fp16.tflite": Object.freeze({ size: 563_818_608, sha256: "8530d0b3e6b9b9dcf1239145c2a853fb749708eaddbb472ff8f0802b50059372" }),
      "same-s/dec_w8a8.tflite": Object.freeze({ size: 94_092_016, sha256: "2fc31cdc42a54342233fb8c6da636565b1191d97002665e21812e981490434a6" }),
      "sa3-m/dit_w8a8.tflite": Object.freeze({ size: 1_667_708_664, sha256: "e60ea3a8b530de93ee7f1fd7b4426597006dbcde7bce45750d39c439f4ef9602" }),
      "sa3-sm-music/dit_w8a8.tflite": Object.freeze({ size: 539_350_360, sha256: "1d8ef99bf10f51cc52b68f7b527d3773828e700758b253edd8a8e088a906e241" }),
    }),
  }),
  licenses: STABLE_AUDIO_SOURCES.licenses,
});

/** What the setup downloads for a runtime on this machine, uv included; null where nothing runs. */
export function stableAudioSources(runtime, { platform = process.platform, arch = process.arch } = {}) {
  const uv = UV_BUILDS[`${platform}-${arch}`];
  if (!uv || !runtime) return null;
  return runtime === "tflite" ? Object.freeze({ ...STABLE_AUDIO_TFLITE_SOURCES, uv }) : STABLE_AUDIO_SOURCES;
}
