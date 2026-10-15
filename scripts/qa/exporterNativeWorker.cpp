#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <psapi.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <atomic>
#include <cmath>
#include <io.h>
#include <fcntl.h>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

struct Api {
    HMODULE codecLibrary = nullptr, formatLibrary = nullptr, utilLibrary = nullptr, scaleLibrary = nullptr;
#define API_FUNCTION(name) decltype(&name) name = nullptr
    API_FUNCTION(avcodec_version);
    API_FUNCTION(avformat_version);
    API_FUNCTION(avutil_version);
    API_FUNCTION(swscale_version);
    API_FUNCTION(avformat_open_input);
    API_FUNCTION(avformat_alloc_context);
    API_FUNCTION(avio_alloc_context);
    API_FUNCTION(avio_context_free);
    API_FUNCTION(av_malloc);
    API_FUNCTION(av_freep);
    API_FUNCTION(avformat_find_stream_info);
    API_FUNCTION(av_find_best_stream);
    API_FUNCTION(avformat_close_input);
    API_FUNCTION(av_read_frame);
    API_FUNCTION(av_seek_frame);
    API_FUNCTION(avcodec_alloc_context3);
    API_FUNCTION(avcodec_parameters_to_context);
    API_FUNCTION(avcodec_open2);
    API_FUNCTION(avcodec_find_encoder_by_name);
    API_FUNCTION(avcodec_send_frame);
    API_FUNCTION(avcodec_receive_packet);
    API_FUNCTION(avcodec_free_context);
    API_FUNCTION(avcodec_send_packet);
    API_FUNCTION(avcodec_receive_frame);
    API_FUNCTION(avcodec_flush_buffers);
    API_FUNCTION(av_packet_alloc);
    API_FUNCTION(av_packet_free);
    API_FUNCTION(av_packet_unref);
    API_FUNCTION(av_frame_alloc);
    API_FUNCTION(av_frame_free);
    API_FUNCTION(av_frame_unref);
    API_FUNCTION(av_buffer_ref);
    API_FUNCTION(av_buffer_unref);
    API_FUNCTION(av_buffer_create);
    API_FUNCTION(av_buffer_pool_init2);
    API_FUNCTION(av_buffer_pool_uninit);
    API_FUNCTION(av_hwdevice_ctx_create);
    API_FUNCTION(av_hwframe_transfer_data);
    API_FUNCTION(av_hwframe_ctx_alloc);
    API_FUNCTION(av_hwframe_ctx_init);
    API_FUNCTION(av_hwframe_get_buffer);
    API_FUNCTION(av_opt_set);
    API_FUNCTION(sws_getContext);
    API_FUNCTION(sws_freeContext);
    API_FUNCTION(sws_scale);
#undef API_FUNCTION
    template<typename Function> void bind(HMODULE library, Function& function, const char* name) {
        function = reinterpret_cast<Function>(GetProcAddress(library, name));
        if (!function) throw std::runtime_error(std::string("missing pinned symbol: ") + name);
    }
    void open(const std::wstring& root) {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if (!AddDllDirectory(root.c_str())) throw std::runtime_error("private DLL directory unavailable");
        const auto load = [&](const wchar_t* name) {
            HMODULE library = LoadLibraryExW((root + L"/" + name).c_str(), nullptr,
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
            if (!library) throw std::runtime_error("pinned library or dependency unavailable");
            return library;
        };
        utilLibrary = load(L"avutil-61.dll");
        codecLibrary = load(L"avcodec-63.dll");
        formatLibrary = load(L"avformat-63.dll");
        scaleLibrary = load(L"swscale-10.dll");
#define BIND(library, name) bind(library, name, #name)
        BIND(codecLibrary, avcodec_version); BIND(formatLibrary, avformat_version);
        BIND(utilLibrary, avutil_version); BIND(scaleLibrary, swscale_version);
        BIND(formatLibrary, avformat_open_input); BIND(formatLibrary, avformat_find_stream_info);
        BIND(formatLibrary, avformat_alloc_context); BIND(formatLibrary, avio_alloc_context);
        BIND(formatLibrary, avio_context_free); BIND(utilLibrary, av_malloc); BIND(utilLibrary, av_freep);
        BIND(formatLibrary, av_find_best_stream); BIND(formatLibrary, avformat_close_input);
        BIND(formatLibrary, av_read_frame); BIND(formatLibrary, av_seek_frame);
        BIND(codecLibrary, avcodec_alloc_context3); BIND(codecLibrary, avcodec_parameters_to_context);
        BIND(codecLibrary, avcodec_open2); BIND(codecLibrary, avcodec_free_context);
        BIND(codecLibrary, avcodec_find_encoder_by_name); BIND(codecLibrary, avcodec_send_frame);
        BIND(codecLibrary, avcodec_receive_packet);
        BIND(codecLibrary, avcodec_send_packet); BIND(codecLibrary, avcodec_receive_frame);
        BIND(codecLibrary, avcodec_flush_buffers); BIND(codecLibrary, av_packet_alloc);
        BIND(codecLibrary, av_packet_free); BIND(codecLibrary, av_packet_unref);
        BIND(utilLibrary, av_frame_alloc); BIND(utilLibrary, av_frame_free); BIND(utilLibrary, av_frame_unref);
        BIND(utilLibrary, av_buffer_ref); BIND(utilLibrary, av_buffer_unref);
        BIND(utilLibrary, av_buffer_create); BIND(utilLibrary, av_buffer_pool_init2);
        BIND(utilLibrary, av_buffer_pool_uninit);
        BIND(utilLibrary, av_hwdevice_ctx_create); BIND(utilLibrary, av_hwframe_transfer_data);
        BIND(utilLibrary, av_hwframe_ctx_alloc); BIND(utilLibrary, av_hwframe_ctx_init);
        BIND(utilLibrary, av_hwframe_get_buffer); BIND(utilLibrary, av_opt_set);
        BIND(scaleLibrary, sws_getContext); BIND(scaleLibrary, sws_freeContext); BIND(scaleLibrary, sws_scale);
#undef BIND
        if (avcodec_version() != AV_VERSION_INT(63, 1, 102) || avformat_version() != AV_VERSION_INT(63, 1, 102) ||
            avutil_version() != AV_VERSION_INT(61, 1, 102) || swscale_version() != AV_VERSION_INT(10, 1, 102))
            throw std::runtime_error("loaded native ABI/version does not match pinned SDK");
    }
};

static void require(int code, const char* operation) {
    if (code < 0) throw std::runtime_error(std::string(operation) + ": " + std::to_string(code));
}

struct SurfaceLifecycle {
    std::atomic<size_t> created{0};
    std::atomic<size_t> issued{0};
    std::atomic<size_t> exhausted{0};
    std::atomic<size_t> descriptorsReleased{0};
    std::atomic<size_t> texturesReleased{0};
    std::atomic<bool> bankReleased{false};
};

struct OutputSurfaceBank {
    Api& api;
    std::shared_ptr<SurfaceLifecycle> lifecycle;
    std::mutex mutex;
    std::vector<Microsoft::WRL::ComPtr<ID3D11Texture2D>> textures;
    struct Descriptor {
        AVD3D11FrameDescriptor frame;
        std::shared_ptr<SurfaceLifecycle> lifecycle;
    };
    OutputSurfaceBank(Api& functions, std::shared_ptr<SurfaceLifecycle> observed) : api(functions), lifecycle(std::move(observed)) {}
    ~OutputSurfaceBank() {
        const size_t count = textures.size();
        textures.clear();
        lifecycle->texturesReleased += count;
        lifecycle->bankReleased = true;
    }
    void open(AVBufferRef* reference) {
        auto device = static_cast<AVD3D11VADeviceContext*>(reinterpret_cast<AVHWDeviceContext*>(reference->data)->hwctx);
        D3D11_TEXTURE2D_DESC description{};
        description.Width = 3840; description.Height = 2160; description.MipLevels = 1; description.ArraySize = 1;
        description.Format = DXGI_FORMAT_NV12; description.SampleDesc.Count = 1;
        description.Usage = D3D11_USAGE_DEFAULT; description.BindFlags = D3D11_BIND_RENDER_TARGET;
        textures.resize(3);
        for (auto& texture : textures) {
            require(device->device->CreateTexture2D(&description, nullptr, &texture), "create fixed output surface");
            ++lifecycle->created;
        }
    }
    static void releaseDescriptor(void*, uint8_t* bytes) {
        auto descriptor = reinterpret_cast<Descriptor*>(bytes);
        descriptor->frame.texture->Release();
        ++descriptor->lifecycle->descriptorsReleased;
        delete descriptor;
    }
    static AVBufferRef* allocate(void* opaque, size_t size) {
        auto& bank = *static_cast<OutputSurfaceBank*>(opaque);
        std::lock_guard<std::mutex> lock(bank.mutex);
        if (size != sizeof(AVD3D11FrameDescriptor) || bank.lifecycle->issued >= bank.textures.size()) {
            ++bank.lifecycle->exhausted;
            return nullptr;
        }
        auto descriptor = new (std::nothrow) Descriptor{};
        if (!descriptor) return nullptr;
        descriptor->lifecycle = bank.lifecycle;
        descriptor->frame.texture = bank.textures[bank.lifecycle->issued].Get(); descriptor->frame.index = 0;
        descriptor->frame.texture->AddRef();
        AVBufferRef* buffer = bank.api.av_buffer_create(reinterpret_cast<uint8_t*>(descriptor), sizeof(AVD3D11FrameDescriptor), releaseDescriptor, nullptr, 0);
        if (!buffer) { releaseDescriptor(nullptr, reinterpret_cast<uint8_t*>(descriptor)); return nullptr; }
        ++bank.lifecycle->issued;
        return buffer;
    }
    static void releaseBank(void* opaque) { delete static_cast<OutputSurfaceBank*>(opaque); }
};

struct HardwareVideo {
    Api& api;
    AVBufferRef* pool = nullptr;
    AVBufferPool* descriptorPool = nullptr;
    AVCodecContext* codec = nullptr;
    AVFrame* frame = nullptr;
    AVPacket* packet = nullptr;
    FILE* output = nullptr;
    uint64_t encodedBytes = 0;
    uint64_t byteBudget = 512ULL * 1024 * 1024;
    int encodedPackets = 0;
    OutputSurfaceBank* surfaces = nullptr;
    std::shared_ptr<SurfaceLifecycle> surfaceLifecycle = std::make_shared<SurfaceLifecycle>();
    bool surfaceExhaustionVerified = false;
    bool encoderOpened = false;
    bool encoderDrained = false;
    explicit HardwareVideo(Api& functions) : api(functions) {}
    ~HardwareVideo() { close(); }
    void close() {
        if (codec && encoderOpened && !encoderDrained && packet) {
            api.av_packet_unref(packet);
            bool sent = false;
            for (int attempts = 0; attempts < 64; ++attempts) {
                if (!sent) {
                    const int submitted = api.avcodec_send_frame(codec, nullptr);
                    if (submitted == 0 || submitted == AVERROR_EOF) sent = true;
                    else if (submitted != AVERROR(EAGAIN)) break;
                }
                const int received = api.avcodec_receive_packet(codec, packet);
                if (received == AVERROR_EOF) { encoderDrained = true; break; }
                if (received == 0) { api.av_packet_unref(packet); continue; }
                if (received != AVERROR(EAGAIN)) break;
            }
        }
        if (output) fclose(output);
        output = nullptr;
        if (packet) api.av_packet_free(&packet);
        if (frame) api.av_frame_free(&frame);
        if (codec) api.avcodec_free_context(&codec);
        if (descriptorPool) {
            if (pool) reinterpret_cast<AVHWFramesContext*>(pool->data)->pool = nullptr;
            api.av_buffer_pool_uninit(&descriptorPool);
        }
        if (pool) api.av_buffer_unref(&pool);
        surfaces = nullptr;
    }
    void open(AVBufferRef* device, const wchar_t* path, uint64_t budget) {
        if (budget < 1024 || budget > 512ULL * 1024 * 1024) throw std::runtime_error("private encoded budget invalid");
        byteBudget = budget;
        const AVCodec* encoder = api.avcodec_find_encoder_by_name("h264_amf");
        if (!encoder) throw std::runtime_error("pinned hardware encoder unavailable");
        pool = api.av_hwframe_ctx_alloc(device);
        if (!pool) throw std::runtime_error("output surface pool allocation failed");
        auto context = reinterpret_cast<AVHWFramesContext*>(pool->data);
        context->format = AV_PIX_FMT_D3D11; context->sw_format = AV_PIX_FMT_NV12;
        context->width = 3840; context->height = 2160; context->initial_pool_size = 0;
        static_cast<AVD3D11VAFramesContext*>(context->hwctx)->BindFlags = D3D11_BIND_RENDER_TARGET;
        auto owner = std::make_unique<OutputSurfaceBank>(api, surfaceLifecycle);
        owner->open(device);
        descriptorPool = api.av_buffer_pool_init2(sizeof(AVD3D11FrameDescriptor), owner.get(), OutputSurfaceBank::allocate, OutputSurfaceBank::releaseBank);
        if (!descriptorPool) throw std::runtime_error("fixed output surface pool initialization failed");
        context->pool = descriptorPool;
        surfaces = owner.release();
        require(api.av_hwframe_ctx_init(pool), "initialize bounded encoder surfaces");
        codec = api.avcodec_alloc_context3(encoder);
        if (!codec) throw std::runtime_error("encoder context allocation failed");
        codec->width = 3840; codec->height = 2160;
        codec->time_base = { 1, 60 }; codec->framerate = { 60, 1 };
        codec->pix_fmt = AV_PIX_FMT_D3D11; codec->gop_size = 120; codec->max_b_frames = 0;
        codec->hw_frames_ctx = api.av_buffer_ref(pool);
        if (!codec->hw_frames_ctx) throw std::runtime_error("encoder pool ownership allocation failed");
        require(api.av_opt_set(codec->priv_data, "usage", "transcoding", 0), "encoder usage");
        require(api.av_opt_set(codec->priv_data, "quality", "balanced", 0), "encoder quality");
        require(api.av_opt_set(codec->priv_data, "rc", "cqp", 0), "encoder rate control");
        for (const char* option : { "qp_i", "qp_p", "qp_b" })
            require(api.av_opt_set(codec->priv_data, option, "23", 0), "encoder quantizer");
        require(api.av_opt_set(codec->priv_data, "async_depth", "2", 0), "bounded encoder queue");
        require(api.av_opt_set(codec->priv_data, "frame_skipping", "0", 0), "encoder frame preservation");
        require(api.avcodec_open2(codec, encoder, nullptr), "open pinned hardware encoder");
        encoderOpened = true;
        frame = api.av_frame_alloc(); packet = api.av_packet_alloc();
        if (!frame || !packet) throw std::runtime_error("encoder frame/packet allocation failed");
        verifySurfaceExhaustion();
        if (_wfopen_s(&output, path, L"wb") != 0 || !output) throw std::runtime_error("private encoded output unavailable");
    }
    void verifySurfaceExhaustion() {
        std::vector<AVFrame*> held;
        try {
            for (int index = 0; index < 4; ++index) {
                AVFrame* borrowed = api.av_frame_alloc();
                if (!borrowed) throw std::runtime_error("surface exhaustion probe allocation failed");
                held.push_back(borrowed);
                const int result = api.av_hwframe_get_buffer(pool, borrowed, 0);
                if (index < 3) require(result, "borrow each precreated output surface");
                else if (result >= 0) throw std::runtime_error("fixed encoder pool unexpectedly grew beyond three surfaces");
            }
            if (surfaces->textures.size() != 3 || surfaceLifecycle->issued != 3 || surfaceLifecycle->exhausted != 1)
                throw std::runtime_error("surface allocation counters do not prove the required ceiling");
            for (auto& borrowed : held) api.av_frame_free(&borrowed);
            held.clear();
            require(api.av_hwframe_get_buffer(pool, frame, 0), "reuse output surface after exhaustion");
            api.av_frame_unref(frame);
            if (surfaceLifecycle->issued != 3) throw std::runtime_error("returned output surface was not reused");
            surfaceExhaustionVerified = true;
        } catch (...) {
            for (auto& borrowed : held) if (borrowed) api.av_frame_free(&borrowed);
            throw;
        }
    }
    AVFrame* acquire(int frameIndex) {
        api.av_frame_unref(frame);
        receive(false);
        const int acquired = api.av_hwframe_get_buffer(pool, frame, 0);
        if (acquired < 0) throw std::runtime_error("fixed encoder output surface pool exhausted; growth refused");
        frame->pts = frameIndex;
        return frame;
    }
    void receive(bool draining) {
        for (;;) {
            const int code = api.avcodec_receive_packet(codec, packet);
            if (code == AVERROR_EOF) return;
            if (code == AVERROR(EAGAIN)) {
                if (draining) throw std::runtime_error("encoder did not complete drain");
                return;
            }
            require(code, "receive encoded packet");
            encodedBytes += packet->size;
            if (encodedBytes > byteBudget) throw std::runtime_error("private encoded-byte budget exceeded");
            if (fwrite(packet->data, 1, packet->size, output) != static_cast<size_t>(packet->size))
                throw std::runtime_error("private encoded write failed");
            ++encodedPackets;
            api.av_packet_unref(packet);
        }
    }
    void submit() {
        const int code = api.avcodec_send_frame(codec, frame);
        if (code == AVERROR(EAGAIN)) {
            receive(false);
            require(api.avcodec_send_frame(codec, frame), "submit encoder frame after backpressure");
        } else { require(code, "submit encoder frame"); }
        receive(false);
    }
    void finish() {
        require(api.avcodec_send_frame(codec, nullptr), "drain hardware encoder");
        receive(true);
        encoderDrained = true;
        if (fflush(output) != 0) throw std::runtime_error("encoded output flush failed");
    }
};

struct NativeScene {
    struct Placement { uint32_t reader, x, y, width, height; };
    struct Layer { uint32_t reader; int32_t x, y; uint32_t width, height; float opacity; uint32_t sourceFrame; };
    struct SourceRect { float x, y, width, height; };
    std::vector<Placement> placements;
    std::vector<Layer> layers;
    std::vector<SourceRect> sources;
    std::vector<float> angles;
    bool overlap = false;
    bool mediaAlpha = false;
    bool captions = false;
    void open(const wchar_t* path, int readers, int frames) {
        FILE* input = nullptr;
        if (_wfopen_s(&input, path, L"rb") != 0 || !input) throw std::runtime_error("shared scene manifest unavailable");
        std::unique_ptr<FILE, decltype(&fclose)> owner(input, fclose);
        uint32_t header[5]{};
        if (fread(header, sizeof(uint32_t), 5, input) != 5 || (header[0] != 0x4e504c31 && header[0] != 0x4e504c32 && header[0] != 0x4e504c33 && header[0] != 0x4e504c34 && header[0] != 0x4e504c35 && header[0] != 0x4e504c36 && header[0] != 0x4e504c37) ||
            header[1] != readers || header[2] != frames || header[3] != 3840 || header[4] != 2160)
            throw std::runtime_error("shared scene manifest contract mismatch");
        overlap = header[0] != 0x4e504c31;
        mediaAlpha = header[0] == 0x4e504c33;
        captions = header[0] == 0x4e504c34;
        if (overlap) {
            static_assert(sizeof(Layer) == 28);
            layers.resize(static_cast<size_t>(readers) * frames);
            if (fread(layers.data(), sizeof(Layer), layers.size(), input) != layers.size())
                throw std::runtime_error("shared per-frame layer bytes incomplete");
            if (header[0] == 0x4e504c35 || header[0] == 0x4e504c36 || header[0] == 0x4e504c37) {
                static_assert(sizeof(SourceRect) == 16);
                sources.resize(layers.size());
                if (fread(sources.data(), sizeof(SourceRect), sources.size(), input) != sources.size())
                    throw std::runtime_error("shared source rectangles incomplete");
                for (const auto& rectangle : sources) {
                    if (!std::isfinite(rectangle.x) || !std::isfinite(rectangle.y) || !std::isfinite(rectangle.width) || !std::isfinite(rectangle.height) ||
                        rectangle.width == 0 || rectangle.height == 0 ||
                        (std::min)(rectangle.x, rectangle.x + rectangle.width) < -0.000001f ||
                        (std::min)(rectangle.y, rectangle.y + rectangle.height) < -0.000001f ||
                        (std::max)(rectangle.x, rectangle.x + rectangle.width) > 1.000001f ||
                        (std::max)(rectangle.y, rectangle.y + rectangle.height) > 1.000001f)
                        throw std::runtime_error("shared source rectangle outside admitted media");
                }
            }
            if (header[0] == 0x4e504c37) {
                static_assert(sizeof(float) == 4);
                angles.resize(layers.size());
                if (fread(angles.data(), sizeof(float), angles.size(), input) != angles.size())
                    throw std::runtime_error("shared rotation angles incomplete");
                for (const float angle : angles)
                    if (!std::isfinite(angle)) throw std::runtime_error("shared rotation angle is not finite");
            }
            if (fgetc(input) != EOF) throw std::runtime_error("shared scene has undeclared bytes");
            for (int frameIndex = 0; frameIndex < frames; ++frameIndex) {
                std::vector<bool> seen(readers, false);
                for (int index = 0; index < readers; ++index) {
                    const auto& layer = layers[static_cast<size_t>(frameIndex) * readers + index];
                    const bool outsideLayout = header[0] != 0x4e504c36 && header[0] != 0x4e504c37 &&
                        (layer.x < 0 || layer.y < 0 || layer.x > 3840 || layer.y > 2160 ||
                         static_cast<int64_t>(layer.x) + layer.width > 3840 || static_cast<int64_t>(layer.y) + layer.height > 2160);
                    if (layer.reader >= static_cast<uint32_t>(readers) || seen[layer.reader] ||
                        !std::isfinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 ||
                        outsideLayout || layer.width == 0 || layer.height == 0 || layer.width > 3840 || layer.height > 2160 ||
                        layer.sourceFrame != static_cast<uint32_t>(mediaAlpha && layer.reader > 0 ? 0 : frameIndex % 180))
                        throw std::runtime_error("shared per-frame layer/source window not supported");
                    seen[layer.reader] = true;
                }
            }
            return;
        }
        placements.resize(readers);
        if (fread(placements.data(), sizeof(Placement), readers, input) != readers || fgetc(input) != EOF)
            throw std::runtime_error("shared scene placement bytes incomplete");
        std::vector<bool> seen(readers, false);
        uint64_t area = 0;
        for (const auto& placement : placements) {
            if (placement.reader >= readers || seen[placement.reader] || placement.x > 3840 || placement.y > 2160 ||
                placement.width > 3840 - placement.x || placement.height > 2160 - placement.y ||
                (placement.x | placement.y | placement.width | placement.height) % 2 != 0 ||
                placement.width != (readers == 1 ? 3840 : 960) || placement.height != (readers == 1 ? 2160 : 540))
                throw std::runtime_error("shared scene placement not supported by opaque fixture compositor");
            seen[placement.reader] = true;
            area += static_cast<uint64_t>(placement.width) * placement.height;
        }
        for (size_t first = 0; first < placements.size(); ++first) {
            for (size_t second = first + 1; second < placements.size(); ++second) {
                const auto& left = placements[first]; const auto& right = placements[second];
                if (left.x < right.x + right.width && right.x < left.x + left.width &&
                    left.y < right.y + right.height && right.y < left.y + left.height)
                    throw std::runtime_error("overlapping shared placement is not admitted by this fixture compositor");
            }
        }
        if (area != 3840ULL * 2160) throw std::runtime_error("shared fixture placement does not cover the output canvas");
    }
};

struct GpuComposite {
    AVD3D11VADeviceContext* device;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessor> processor;
    int streamCount;
    GpuComposite(AVBufferRef* reference, int count) : streamCount(count) {
        device = static_cast<AVD3D11VADeviceContext*>(reinterpret_cast<AVHWDeviceContext*>(reference->data)->hwctx);
        D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
        content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
        content.InputFrameRate = { 60, 1 }; content.OutputFrameRate = { 60, 1 };
        content.InputWidth = 3840; content.InputHeight = 2160;
        content.OutputWidth = 3840; content.OutputHeight = 2160;
        content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
        require(device->video_device->CreateVideoProcessorEnumerator(&content, &enumerator), "GPU overlap enumerator");
        D3D11_VIDEO_PROCESSOR_CAPS caps{};
        require(enumerator->GetVideoProcessorCaps(&caps), "GPU overlap capabilities");
        if (caps.MaxInputStreams < static_cast<UINT>(count) || caps.MaxStreamStates < static_cast<UINT>(count))
            throw std::runtime_error("GPU overlap stream budget unavailable");
        require(device->video_device->CreateVideoProcessor(enumerator.Get(), 0, &processor), "GPU overlap processor");
        D3D11_VIDEO_COLOR background{};
        background.YCbCr.Y = 16.0f / 255; background.YCbCr.Cb = 128.0f / 255; background.YCbCr.Cr = 128.0f / 255;
        background.YCbCr.A = 1;
        device->video_context->VideoProcessorSetOutputBackgroundColor(processor.Get(), TRUE, &background);
        const RECT canvas = { 0, 0, 3840, 2160 };
        device->video_context->VideoProcessorSetOutputTargetRect(processor.Get(), TRUE, &canvas);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE colour{};
        colour.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        device->video_context->VideoProcessorSetOutputColorSpace(processor.Get(), &colour);
        for (int index = 0; index < count; ++index) {
            device->video_context->VideoProcessorSetStreamFrameFormat(processor.Get(), index, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            device->video_context->VideoProcessorSetStreamColorSpace(processor.Get(), index, &colour);
            device->video_context->VideoProcessorSetStreamAutoProcessingMode(processor.Get(), index, FALSE);
        }
    }
    void compose(AVFrame* output, const std::vector<AVFrame*>& sources, const NativeScene& scene, int frameIndex) {
        std::vector<Microsoft::WRL::ComPtr<ID3D11VideoProcessorInputView>> views(streamCount);
        std::vector<D3D11_VIDEO_PROCESSOR_STREAM> streams(streamCount);
        const RECT source = { 0, 0, 3840, 2160 };
        for (int index = 0; index < streamCount; ++index) {
            const auto& layer = scene.layers.at(static_cast<size_t>(frameIndex) * streamCount + index);
            AVFrame* frame = sources.at(layer.reader);
            if (!frame || frame->format != AV_PIX_FMT_D3D11 || frame->width != 3840 || frame->height != 2160)
                throw std::runtime_error("overlap source is not admitted hardware frame");
            D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input{};
            input.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
            input.Texture2D.ArraySlice = static_cast<UINT>(reinterpret_cast<uintptr_t>(frame->data[1]));
            require(device->video_device->CreateVideoProcessorInputView(reinterpret_cast<ID3D11Texture2D*>(frame->data[0]),
                enumerator.Get(), &input, &views[index]), "GPU overlap input view");
            const RECT destination = { static_cast<LONG>(layer.x), static_cast<LONG>(layer.y),
                static_cast<LONG>(layer.x + layer.width), static_cast<LONG>(layer.y + layer.height) };
            device->video_context->VideoProcessorSetStreamSourceRect(processor.Get(), index, TRUE, &source);
            device->video_context->VideoProcessorSetStreamDestRect(processor.Get(), index, TRUE, &destination);
            device->video_context->VideoProcessorSetStreamAlpha(processor.Get(), index, TRUE, layer.opacity);
            BOOL rectangleEnabled = FALSE, alphaEnabled = FALSE;
            RECT observed{};
            float observedAlpha = 0;
            device->video_context->VideoProcessorGetStreamDestRect(processor.Get(), index, &rectangleEnabled, &observed);
            device->video_context->VideoProcessorGetStreamAlpha(processor.Get(), index, &alphaEnabled, &observedAlpha);
            if (!rectangleEnabled || !alphaEnabled || std::abs(observedAlpha - layer.opacity) > 0.00001f ||
                observed.left != destination.left || observed.top != destination.top ||
                observed.right != destination.right || observed.bottom != destination.bottom)
                throw std::runtime_error("GPU overlap state differs from admitted shared layer");
            streams[index].Enable = TRUE; streams[index].pInputSurface = views[index].Get();
            streams[index].OutputIndex = frameIndex; streams[index].InputFrameOrField = frameIndex;
        }
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC descriptor{};
        auto outputTexture = reinterpret_cast<ID3D11Texture2D*>(output->data[0]);
        D3D11_TEXTURE2D_DESC textureDescriptor{};
        outputTexture->GetDesc(&textureDescriptor);
        if (textureDescriptor.ArraySize > 1) {
            descriptor.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2DARRAY;
            descriptor.Texture2DArray.FirstArraySlice = static_cast<UINT>(reinterpret_cast<uintptr_t>(output->data[1]));
            descriptor.Texture2DArray.ArraySize = 1;
        } else { descriptor.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D; }
        Microsoft::WRL::ComPtr<ID3D11VideoProcessorOutputView> target;
        require(device->video_device->CreateVideoProcessorOutputView(outputTexture,
            enumerator.Get(), &descriptor, &target), "GPU overlap output view");
        require(device->video_context->VideoProcessorBlt(processor.Get(), target.Get(), frameIndex, streamCount, streams.data()), "GPU overlap composition");
        require(device->device->GetDeviceRemovedReason(), "GPU overlap device state");
    }
};

struct CaptionDecoder {
    Api& api;
    AVFormatContext* format = nullptr;
    AVIOContext* input = nullptr;
    AVCodecContext* codec = nullptr;
    AVPacket* packet = nullptr;
    AVFrame* frame = nullptr;
    AVRational clock{};
    uint64_t bytes = 0;
    bool draining = false;
    explicit CaptionDecoder(Api& functions) : api(functions) {}
    ~CaptionDecoder() {
        if (frame) api.av_frame_free(&frame);
        if (packet) api.av_packet_free(&packet);
        if (codec) api.avcodec_free_context(&codec);
        if (format) api.avformat_close_input(&format);
        if (input) { api.av_freep(&input->buffer); api.avio_context_free(&input); }
    }
    static int read(void* opaque, uint8_t* destination, int requested) {
        auto& owner = *static_cast<CaptionDecoder*>(opaque);
        const size_t received = fread(destination, 1, requested, stdin);
        owner.bytes += received;
        if (owner.bytes > 512ULL * 1024 * 1024) return AVERROR(EINVAL);
        return received ? static_cast<int>(received) : AVERROR_EOF;
    }
    void open() {
        auto buffer = static_cast<unsigned char*>(api.av_malloc(65536));
        if (!buffer) throw std::runtime_error("caption input buffer allocation failed");
        input = api.avio_alloc_context(buffer, 65536, 0, this, read, nullptr, nullptr);
        if (!input) { api.av_freep(&buffer); throw std::runtime_error("caption input owner allocation failed"); }
        format = api.avformat_alloc_context();
        if (!format) throw std::runtime_error("caption format owner allocation failed");
        format->pb = input; format->flags |= AVFMT_FLAG_CUSTOM_IO;
        require(api.av_opt_set(format, "probesize", "65536", 0), "caption probe budget");
        require(api.avformat_open_input(&format, nullptr, nullptr, nullptr), "caption streaming container");
        if (format->nb_streams != 1 || format->streams[0]->codecpar->codec_id != AV_CODEC_ID_QTRLE ||
            format->streams[0]->codecpar->width != 3840 || format->streams[0]->codecpar->height != 2160)
            throw std::runtime_error("caption compressed stream contract differs");
        const AVCodec* decoder = nullptr;
        require(api.av_find_best_stream(format, AVMEDIA_TYPE_VIDEO, 0, -1, &decoder, 0), "caption decoder");
        codec = api.avcodec_alloc_context3(decoder);
        if (!codec) throw std::runtime_error("caption codec owner allocation failed");
        require(api.avcodec_parameters_to_context(codec, format->streams[0]->codecpar), "caption codec parameters");
        codec->thread_count = 1;
        require(api.avcodec_open2(codec, decoder, nullptr), "caption lossless decoder open");
        clock = format->streams[0]->time_base;
        if (clock.num <= 0 || clock.den <= 0) throw std::runtime_error("caption compressed clock unavailable");
        packet = api.av_packet_alloc(); frame = api.av_frame_alloc();
        if (!packet || !frame) throw std::runtime_error("caption frame/packet owner allocation failed");
    }
    AVFrame* next(int frameIndex) {
        api.av_frame_unref(frame);
        for (int work = 0; work < 10000; ++work) {
            const int received = api.avcodec_receive_frame(codec, frame);
            if (received == 0) {
                if (frame->format != AV_PIX_FMT_ARGB || frame->width != 3840 || frame->height != 2160 ||
                    frame->linesize[0] < 3840 * 4 || frame->best_effort_timestamp == AV_NOPTS_VALUE ||
                    frame->best_effort_timestamp != static_cast<int64_t>(frameIndex) * clock.den / (60LL * clock.num) ||
                    static_cast<int64_t>(frameIndex) * clock.den % (60LL * clock.num) != 0)
                    throw std::runtime_error("caption lossless frame/clock differs");
                return frame;
            }
            if (received == AVERROR_EOF) return nullptr;
            if (received != AVERROR(EAGAIN) || draining) throw std::runtime_error("caption decoder stalled/failed");
            api.av_packet_unref(packet);
            const int readResult = api.av_read_frame(format, packet);
            if (readResult == AVERROR_EOF) {
                draining = true;
                require(api.avcodec_send_packet(codec, nullptr), "caption decoder drain");
            } else {
                require(readResult, "caption compressed packet");
                if (packet->stream_index != 0) throw std::runtime_error("unexpected caption stream");
                require(api.avcodec_send_packet(codec, packet), "caption compressed frame submit");
            }
        }
        throw std::runtime_error("caption packet work budget exceeded");
    }
};

struct ShaderComposite {
    AVD3D11VADeviceContext* device;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> canvas;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> target;
    Microsoft::WRL::ComPtr<ID3D11VertexShader> vertex;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> pixel;
    struct LayerConstants {
        Microsoft::WRL::ComPtr<ID3D11Buffer> buffer;
        float values[12] = {};
        bool initialized = false;
    };
    std::vector<LayerConstants> constants;
    uint64_t constantUploads = 0;
    Microsoft::WRL::ComPtr<ID3D11SamplerState> sampler;
    Microsoft::WRL::ComPtr<ID3D11BlendState> blend;
    Microsoft::WRL::ComPtr<ID3D11RasterizerState> rasterizer;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessor> converter;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorInputView> convertedInput;
    struct Source {
        Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
        Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> luma;
        Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> chroma;
    };
    std::vector<Source> sources;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> alphaTexture;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> alphaView;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> captionTexture;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> captionView;
    std::vector<unsigned char> captionPixels;
    std::unique_ptr<CaptionDecoder> captionDecoder;
    int captionFrames = 0;
    int captionUploads = 0;
    static void premultiplyRgba(std::vector<unsigned char>& rgba) {
        for (size_t offset = 0; offset < rgba.size(); offset += 4) {
            const uint32_t alpha = rgba[offset + 3];
            for (size_t channel = 0; channel < 3; ++channel)
                rgba[offset + channel] = static_cast<unsigned char>((rgba[offset + channel] * alpha + 127) / 255);
        }
    }
    ShaderComposite(Api& api, AVBufferRef* reference, int count, const wchar_t* alphaPath, bool captions, bool compressedCaptions) : constants(count + 1), sources(count) {
        if (count != 1 && count != 16) throw std::runtime_error("shader source-slot budget invalid");
        device = static_cast<AVD3D11VADeviceContext*>(reinterpret_cast<AVHWDeviceContext*>(reference->data)->hwctx);
        const char* shader = R"HLSL(
cbuffer Layer : register(b0) { float4 box; float4 parameters; float4 sourceBox; };
Texture2D<float> luma : register(t0);
Texture2D<float2> chroma : register(t1);
Texture2D<float4> image : register(t2);
Texture2D<float4> caption : register(t3);
SamplerState sampleLinear : register(s0);
struct Vertex { float4 position : SV_Position; float2 uv : TEXCOORD0; };
Vertex vertexMain(uint index : SV_VertexID) {
    float2 corners[4] = { float2(0,0), float2(1,0), float2(0,1), float2(1,1) };
    Vertex result;
    float2 corner = corners[index];
    result.uv = sourceBox.xy + corner * sourceBox.zw;
    float2 position = box.xy + corner * box.zw;
    float2 offset = (corner - float2(0.5, 0.5)) * box.zw;
    float sine, cosine;
    sincos(parameters.w, sine, cosine);
    position = box.xy + box.zw * 0.5 + float2(offset.x * cosine - offset.y * sine,
        offset.x * sine + offset.y * cosine);
    result.position = float4(position.x / 1920 - 1, 1 - position.y / 1080, 0, 1);
    return result;
}
float4 pixelMain(Vertex value) : SV_Target {
    if (parameters.y > 0.5) {
        float4 rgba = parameters.y > 1.5 ? caption.Sample(sampleLinear, value.uv) : image.Sample(sampleLinear, value.uv);
        if (parameters.y > 1.5 && parameters.z > 0.5) rgba = rgba.gbar;
        float3 rgb = rgba.a > 0 ? rgba.rgb / rgba.a : float3(0, 0, 0);
        return float4(rgb, rgba.a * parameters.x);
    }
    float brightness = (luma.Sample(sampleLinear, value.uv) - 16.0 / 255.0) * 1.16438356;
    float2 colour = chroma.Sample(sampleLinear, value.uv) - float2(128.0 / 255.0, 128.0 / 255.0);
    float3 rgb = float3(brightness + 1.59602678 * colour.y,
        brightness - 0.39176229 * colour.x - 0.81296764 * colour.y,
        brightness + 2.01723214 * colour.x);
    return float4(saturate(rgb), parameters.x);
}
)HLSL";
        const auto compile = [&](const char* entry, const char* profile) {
            Microsoft::WRL::ComPtr<ID3DBlob> code, error;
            const HRESULT result = D3DCompile(shader, strlen(shader), "private-native-compositor", nullptr, nullptr,
                entry, profile, D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &error);
            if (FAILED(result)) throw std::runtime_error(error ? std::string(static_cast<char*>(error->GetBufferPointer()), error->GetBufferSize()) : "shader compilation failed");
            return code;
        };
        const auto vertexCode = compile("vertexMain", "vs_5_0"), pixelCode = compile("pixelMain", "ps_5_0");
        require(device->device->CreateVertexShader(vertexCode->GetBufferPointer(), vertexCode->GetBufferSize(), nullptr, &vertex), "shader vertex owner");
        require(device->device->CreatePixelShader(pixelCode->GetBufferPointer(), pixelCode->GetBufferSize(), nullptr, &pixel), "shader pixel owner");
        D3D11_BUFFER_DESC buffer{};
        buffer.ByteWidth = 48; buffer.Usage = D3D11_USAGE_DEFAULT; buffer.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        for (auto& slot : constants) {
            require(device->device->CreateBuffer(&buffer, nullptr, &slot.buffer), "shader layer constants");
        }
        D3D11_SAMPLER_DESC sample{};
        sample.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sample.AddressU = sample.AddressV = sample.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        sample.MaxLOD = D3D11_FLOAT32_MAX;
        require(device->device->CreateSamplerState(&sample, &sampler), "shader sampling state");
        D3D11_BLEND_DESC blendDescription{};
        auto& render = blendDescription.RenderTarget[0];
        render.BlendEnable = TRUE; render.SrcBlend = D3D11_BLEND_SRC_ALPHA; render.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        render.BlendOp = render.BlendOpAlpha = D3D11_BLEND_OP_ADD;
        render.SrcBlendAlpha = D3D11_BLEND_ONE; render.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        render.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        require(device->device->CreateBlendState(&blendDescription, &blend), "shader alpha state");
        D3D11_RASTERIZER_DESC raster{};
        raster.FillMode = D3D11_FILL_SOLID; raster.CullMode = D3D11_CULL_NONE; raster.DepthClipEnable = TRUE;
        require(device->device->CreateRasterizerState(&raster, &rasterizer), "shader raster state");
        D3D11_TEXTURE2D_DESC texture{};
        texture.Width = 3840; texture.Height = 2160; texture.MipLevels = 1; texture.ArraySize = 1;
        texture.Format = DXGI_FORMAT_R8G8B8A8_UNORM; texture.SampleDesc.Count = 1;
        texture.Usage = D3D11_USAGE_DEFAULT; texture.BindFlags = D3D11_BIND_RENDER_TARGET;
        require(device->device->CreateTexture2D(&texture, nullptr, &canvas), "shader full-resolution canvas");
        require(device->device->CreateRenderTargetView(canvas.Get(), nullptr, &target), "shader canvas target");
        texture.Format = DXGI_FORMAT_NV12; texture.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        for (size_t index = 0; index < sources.size(); ++index) {
            if (alphaPath && index > 0) continue;
            auto& source = sources[index];
            require(device->device->CreateTexture2D(&texture, nullptr, &source.texture), "shader full-resolution source slot");
            D3D11_SHADER_RESOURCE_VIEW_DESC view{};
            view.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D; view.Texture2D.MipLevels = 1;
            view.Format = DXGI_FORMAT_R8_UNORM;
            require(device->device->CreateShaderResourceView(source.texture.Get(), &view, &source.luma), "shader luma view");
            view.Format = DXGI_FORMAT_R8G8_UNORM;
            require(device->device->CreateShaderResourceView(source.texture.Get(), &view, &source.chroma), "shader chroma view");
        }
        if (alphaPath) {
            FILE* input = nullptr;
            if (_wfopen_s(&input, alphaPath, L"rb") != 0 || !input) throw std::runtime_error("admitted RGBA image unavailable");
            std::unique_ptr<FILE, decltype(&fclose)> owned(input, fclose);
            std::vector<unsigned char> rgba(3840 * 2160 * 4);
            if (fread(rgba.data(), 1, rgba.size(), input) != rgba.size() || fgetc(input) != EOF)
                throw std::runtime_error("admitted RGBA image dimensions/bytes differ");
            premultiplyRgba(rgba);
            texture.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
            D3D11_SUBRESOURCE_DATA initial{};
            initial.pSysMem = rgba.data(); initial.SysMemPitch = 3840 * 4;
            require(device->device->CreateTexture2D(&texture, &initial, &alphaTexture), "shader immutable alpha image");
            require(device->device->CreateShaderResourceView(alphaTexture.Get(), nullptr, &alphaView), "shader alpha view");
        }
        if (captions) {
            captionPixels.resize(3840 * 2160 * 4);
            if (compressedCaptions) {
                captionDecoder = std::make_unique<CaptionDecoder>(api);
                captionDecoder->open();
            }
            texture.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
            require(device->device->CreateTexture2D(&texture, nullptr, &captionTexture), "bounded caption texture");
            require(device->device->CreateShaderResourceView(captionTexture.Get(), nullptr, &captionView), "caption view");
        }
        D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
        content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
        content.InputFrameRate = { 60, 1 }; content.OutputFrameRate = { 60, 1 };
        content.InputWidth = content.OutputWidth = 3840; content.InputHeight = content.OutputHeight = 2160;
        content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
        require(device->video_device->CreateVideoProcessorEnumerator(&content, &enumerator), "single-stream encoder conversion enumerator");
        require(device->video_device->CreateVideoProcessor(enumerator.Get(), 0, &converter), "single-stream encoder converter");
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input{};
        input.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        require(device->video_device->CreateVideoProcessorInputView(canvas.Get(), enumerator.Get(), &input, &convertedInput), "single-stream canvas view");
        const RECT rectangle = { 0, 0, 3840, 2160 };
        device->video_context->VideoProcessorSetStreamSourceRect(converter.Get(), 0, TRUE, &rectangle);
        device->video_context->VideoProcessorSetStreamDestRect(converter.Get(), 0, TRUE, &rectangle);
        device->video_context->VideoProcessorSetOutputTargetRect(converter.Get(), TRUE, &rectangle);
        device->video_context->VideoProcessorSetStreamAutoProcessingMode(converter.Get(), 0, FALSE);
        device->video_context->VideoProcessorSetStreamFrameFormat(converter.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE colour{};
        colour.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        device->video_context->VideoProcessorSetStreamColorSpace(converter.Get(), 0, &colour);
        device->video_context->VideoProcessorSetOutputColorSpace(converter.Get(), &colour);
    }
    void setLayerConstants(size_t index, const float (&values)[12]) {
        auto& slot = constants.at(index);
        if (!slot.initialized || memcmp(slot.values, values, sizeof(values)) != 0) {
            device->device_context->UpdateSubresource(slot.buffer.Get(), 0, nullptr, values, 0, 0);
            memcpy(slot.values, values, sizeof(values));
            slot.initialized = true;
            ++constantUploads;
        }
        ID3D11Buffer* buffer = slot.buffer.Get();
        device->device_context->VSSetConstantBuffers(0, 1, &buffer);
        device->device_context->PSSetConstantBuffers(0, 1, &buffer);
    }
    void compose(AVFrame* output, const std::vector<AVFrame*>& decoded, const NativeScene& scene, int frameIndex) {
        const auto context = device->device_context;
        const float background[4] = { 0, 0, 0, 1 };
        context->ClearRenderTargetView(target.Get(), background);
        ID3D11RenderTargetView* destination = target.Get();
        context->OMSetRenderTargets(1, &destination, nullptr);
        context->OMSetBlendState(blend.Get(), nullptr, 0xffffffff);
        context->RSSetState(rasterizer.Get());
        const D3D11_VIEWPORT viewport = { 0, 0, 3840, 2160, 0, 1 };
        context->RSSetViewports(1, &viewport);
        context->IASetInputLayout(nullptr); context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
        context->VSSetShader(vertex.Get(), nullptr, 0); context->PSSetShader(pixel.Get(), nullptr, 0);
        ID3D11SamplerState* sampling = sampler.Get(); context->PSSetSamplers(0, 1, &sampling);
        const D3D11_BOX sourceBox = { 0, 0, 0, 3840, 2160, 1 };
        for (size_t index = 0; index < sources.size(); ++index) {
            const auto& layer = scene.layers.at(static_cast<size_t>(frameIndex) * sources.size() + index);
            auto& source = sources.at(layer.reader);
            const bool alpha = scene.mediaAlpha && layer.reader > 0;
            if (!alpha) {
                AVFrame* frame = decoded.at(layer.reader);
                if (!frame || frame->format != AV_PIX_FMT_D3D11 || frame->width != 3840 || frame->height != 2160)
                    throw std::runtime_error("shader source frame differs from admitted fixture");
                context->CopySubresourceRegion(source.texture.Get(), 0, 0, 0, 0, reinterpret_cast<ID3D11Texture2D*>(frame->data[0]),
                    static_cast<UINT>(reinterpret_cast<uintptr_t>(frame->data[1])), &sourceBox);
            } else if (!alphaView) { throw std::runtime_error("admitted alpha media view missing"); }
            const auto sourceRect = scene.sources.empty() ? NativeScene::SourceRect{ 0, 0, 1, 1 } :
                scene.sources.at(static_cast<size_t>(frameIndex) * sources.size() + index);
            const float angle = scene.angles.empty() ? 0.0f : scene.angles.at(static_cast<size_t>(frameIndex) * sources.size() + index);
            const float values[12] = { static_cast<float>(layer.x), static_cast<float>(layer.y),
                static_cast<float>(layer.width), static_cast<float>(layer.height), layer.opacity, alpha ? 1.0f : 0.0f, 0, angle,
                sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height };
            setLayerConstants(index, values);
            ID3D11ShaderResourceView* views[4] = { source.luma.Get(), source.chroma.Get(), alpha ? alphaView.Get() : nullptr, nullptr };
            context->PSSetShaderResources(0, 4, views); context->Draw(4, 0);
        }
        if (scene.captions) {
            if (!captionView) throw std::runtime_error("required caption view missing");
            if (captionDecoder) {
                AVFrame* frame = captionDecoder->next(frameIndex);
                if (!frame) throw std::runtime_error("required caption compressed frames truncated");
                const size_t rowBytes = 3840 * 4;
                if (frame->linesize[0] < static_cast<int>(rowBytes)) throw std::runtime_error("required caption row stride differs");
                bool changed = captionUploads == 0;
                for (int row = 0; row < 2160 && !changed; ++row) {
                    changed = memcmp(captionPixels.data() + row * rowBytes,
                        frame->data[0] + static_cast<size_t>(row) * frame->linesize[0], rowBytes) != 0;
                }
                if (changed) {
                    context->UpdateSubresource(captionTexture.Get(), 0, nullptr, frame->data[0], frame->linesize[0], 0);
                    for (int row = 0; row < 2160; ++row) {
                        memcpy(captionPixels.data() + row * rowBytes,
                            frame->data[0] + static_cast<size_t>(row) * frame->linesize[0], rowBytes);
                    }
                    ++captionUploads;
                }
            } else {
                if (fread(captionPixels.data(), 1, captionPixels.size(), stdin) != captionPixels.size())
                    throw std::runtime_error("required caption frame stream truncated");
                context->UpdateSubresource(captionTexture.Get(), 0, nullptr, captionPixels.data(), 3840 * 4, 0);
            }
            const float values[12] = { 0, 0, 3840, 2160, 1, 2, captionDecoder ? 1.0f : 0.0f, 0, 0, 0, 1, 1 };
            setLayerConstants(sources.size(), values);
            ID3D11ShaderResourceView* views[4] = { nullptr, nullptr, nullptr, captionView.Get() };
            context->PSSetShaderResources(0, 4, views); context->Draw(4, 0);
            ++captionFrames;
        }
        ID3D11ShaderResourceView* empty[4] = { nullptr, nullptr, nullptr, nullptr }; context->PSSetShaderResources(0, 4, empty);
        context->OMSetRenderTargets(0, nullptr, nullptr);
        D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC view{};
        auto texture = reinterpret_cast<ID3D11Texture2D*>(output->data[0]);
        D3D11_TEXTURE2D_DESC description{}; texture->GetDesc(&description);
        if (description.ArraySize > 1) {
            view.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2DARRAY;
            view.Texture2DArray.FirstArraySlice = static_cast<UINT>(reinterpret_cast<uintptr_t>(output->data[1]));
            view.Texture2DArray.ArraySize = 1;
        } else { view.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D; }
        Microsoft::WRL::ComPtr<ID3D11VideoProcessorOutputView> encoded;
        require(device->video_device->CreateVideoProcessorOutputView(texture, enumerator.Get(), &view, &encoded), "shader encoded output view");
        D3D11_VIDEO_PROCESSOR_STREAM stream{};
        stream.Enable = TRUE; stream.pInputSurface = convertedInput.Get();
        require(device->video_context->VideoProcessorBlt(converter.Get(), encoded.Get(), 0, 1, &stream), "single-stream shader output conversion");
        require(device->device->GetDeviceRemovedReason(), "shader compositor device state");
    }
};

struct GpuResize {
    Api& api;
    AVD3D11VADeviceContext* device;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessor> processor;
    struct Slot {
        Microsoft::WRL::ComPtr<ID3D11Texture2D> reduced;
        Microsoft::WRL::ComPtr<ID3D11Texture2D> staging;
        Microsoft::WRL::ComPtr<ID3D11VideoProcessorOutputView> target;
    };
    std::vector<Slot> slots;
    SwsContext* scaler = nullptr;
    D3D11_VIDEO_PROCESSOR_CAPS capabilities{};
    GpuResize(Api& functions, AVBufferRef* reference, int slotCount) : api(functions), slots(slotCount) {
        if (slotCount != 1 && slotCount != 16) throw std::runtime_error("GPU staging slot budget invalid");
        device = static_cast<AVD3D11VADeviceContext*>(reinterpret_cast<AVHWDeviceContext*>(reference->data)->hwctx);
        D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
        content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
        content.InputFrameRate = { 60, 1 }; content.OutputFrameRate = { 60, 1 };
        content.InputWidth = 3840; content.InputHeight = 2160;
        content.OutputWidth = 960; content.OutputHeight = 540;
        content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
        require(device->video_device->CreateVideoProcessorEnumerator(&content, &enumerator), "GPU resize enumerator");
        require(enumerator->GetVideoProcessorCaps(&capabilities), "GPU compositor stream capability");
        UINT support = 0;
        require(enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &support), "GPU resize output support");
        if (!(support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) throw std::runtime_error("GPU NV12 output unavailable");
        require(device->video_device->CreateVideoProcessor(enumerator.Get(), 0, &processor), "GPU resize processor");
        for (auto& slot : slots) {
            D3D11_TEXTURE2D_DESC texture{};
            texture.Width = 960; texture.Height = 540; texture.MipLevels = 1; texture.ArraySize = 1;
            texture.Format = DXGI_FORMAT_NV12; texture.SampleDesc.Count = 1;
            texture.Usage = D3D11_USAGE_DEFAULT; texture.BindFlags = D3D11_BIND_RENDER_TARGET;
            require(device->device->CreateTexture2D(&texture, nullptr, &slot.reduced), "GPU reduced texture");
            texture.Usage = D3D11_USAGE_STAGING; texture.BindFlags = 0; texture.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            require(device->device->CreateTexture2D(&texture, nullptr, &slot.staging), "GPU bounded staging texture");
            D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output{};
            output.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
            require(device->video_device->CreateVideoProcessorOutputView(slot.reduced.Get(), enumerator.Get(), &output, &slot.target), "GPU target view");
        }
        const RECT source = { 0, 0, 3840, 2160 }, destination = { 0, 0, 960, 540 };
        device->video_context->VideoProcessorSetStreamFrameFormat(processor.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        device->video_context->VideoProcessorSetStreamSourceRect(processor.Get(), 0, TRUE, &source);
        device->video_context->VideoProcessorSetStreamDestRect(processor.Get(), 0, TRUE, &destination);
        device->video_context->VideoProcessorSetOutputTargetRect(processor.Get(), TRUE, &destination);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE colour{};
        colour.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        device->video_context->VideoProcessorSetStreamColorSpace(processor.Get(), 0, &colour);
        device->video_context->VideoProcessorSetOutputColorSpace(processor.Get(), &colour);
        scaler = api.sws_getContext(960, 540, AV_PIX_FMT_NV12, 32, 18, AV_PIX_FMT_RGB24, SWS_BICUBIC, nullptr, nullptr, nullptr);
        if (!scaler) throw std::runtime_error("GPU comparison scaler unavailable");
    }
    ~GpuResize() { if (scaler) api.sws_freeContext(scaler); }
    void submit(AVFrame* frame, int slotIndex) {
        auto& slot = slots.at(slotIndex);
        auto texture = reinterpret_cast<ID3D11Texture2D*>(frame->data[0]);
        if (!texture || frame->format != AV_PIX_FMT_D3D11) throw std::runtime_error("GPU resize requires a hardware frame");
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC descriptor{};
        descriptor.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        descriptor.Texture2D.ArraySlice = static_cast<UINT>(reinterpret_cast<uintptr_t>(frame->data[1]));
        Microsoft::WRL::ComPtr<ID3D11VideoProcessorInputView> input;
        require(device->video_device->CreateVideoProcessorInputView(texture, enumerator.Get(), &descriptor, &input), "GPU source view");
        D3D11_VIDEO_PROCESSOR_STREAM stream{};
        stream.Enable = TRUE; stream.pInputSurface = input.Get();
        require(device->video_context->VideoProcessorBlt(processor.Get(), slot.target.Get(), 0, 1, &stream), "GPU resize frame");
        device->device_context->CopyResource(slot.staging.Get(), slot.reduced.Get());
    }
    void read(int slotIndex, unsigned char* output) {
        auto& slot = slots.at(slotIndex);
        D3D11_MAPPED_SUBRESOURCE mapped{};
        require(device->device_context->Map(slot.staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "GPU reduced readback");
        const unsigned char* planes[4] = { static_cast<unsigned char*>(mapped.pData),
            static_cast<unsigned char*>(mapped.pData) + mapped.RowPitch * 540, nullptr, nullptr };
        const int strides[4] = { static_cast<int>(mapped.RowPitch), static_cast<int>(mapped.RowPitch), 0, 0 };
        unsigned char* destinations[4] = { output, nullptr, nullptr, nullptr };
        const int destinationStrides[4] = { 96, 0, 0, 0 };
        const int rows = api.sws_scale(scaler, planes, strides, 0, 540, destinations, destinationStrides);
        device->device_context->Unmap(slot.staging.Get(), 0);
        if (rows != 18) throw std::runtime_error("GPU comparison frame incomplete");
    }
};

struct Reader {
    Api& api;
    AVFormatContext* format = nullptr;
    AVCodecContext* codec = nullptr;
    AVPacket* packet = nullptr;
    AVFrame* frame = nullptr;
    AVFrame* transferred = nullptr;
    SwsContext* scaler = nullptr;
    int stream = -1;
    bool draining = false;
    explicit Reader(Api& functions) : api(functions) {}
    ~Reader() {
        if (scaler) api.sws_freeContext(scaler);
        if (frame) api.av_frame_free(&frame);
        if (transferred) api.av_frame_free(&transferred);
        if (packet) api.av_packet_free(&packet);
        if (codec) api.avcodec_free_context(&codec);
        if (format) api.avformat_close_input(&format);
    }
    static AVPixelFormat hardwareFormat(AVCodecContext*, const AVPixelFormat* formats) {
        for (const AVPixelFormat* format = formats; *format != AV_PIX_FMT_NONE; ++format)
            if (*format == AV_PIX_FMT_D3D11) return *format;
        return AV_PIX_FMT_NONE;
    }
    void open(const std::string& source, AVBufferRef* device) {
        require(api.avformat_open_input(&format, source.c_str(), nullptr, nullptr), "open frozen source");
        require(api.avformat_find_stream_info(format, nullptr), "read source index");
        const AVCodec* decoder = nullptr;
        stream = api.av_find_best_stream(format, AVMEDIA_TYPE_VIDEO, -1, -1, &decoder, 0);
        require(stream, "find video stream");
        codec = api.avcodec_alloc_context3(decoder);
        if (!codec) throw std::runtime_error("decoder allocation failed");
        require(api.avcodec_parameters_to_context(codec, format->streams[stream]->codecpar), "copy source codec");
        codec->thread_count = 1;
        codec->extra_hw_frames = 0;
        if (device) {
            codec->hw_device_ctx = api.av_buffer_ref(device);
            if (!codec->hw_device_ctx) throw std::runtime_error("device ownership allocation failed");
            codec->get_format = hardwareFormat;
        }
        require(api.avcodec_open2(codec, decoder, nullptr), "open decoder");
        packet = api.av_packet_alloc(); frame = api.av_frame_alloc(); transferred = api.av_frame_alloc();
        if (!packet || !frame || !transferred) throw std::runtime_error("bounded frame allocation failed");
    }
    void rewind() {
        const AVStream* video = format->streams[stream];
        const int64_t start = video->start_time == AV_NOPTS_VALUE ? 0 : video->start_time;
        require(api.av_seek_frame(format, stream, start, AVSEEK_FLAG_BACKWARD), "rewind frozen source");
        api.avcodec_flush_buffers(codec);
        api.av_packet_unref(packet);
        draining = false;
    }
    AVFrame* next(bool hardware, bool transfer) {
        api.av_frame_unref(frame); api.av_frame_unref(transferred);
        for (int attempts = 0; attempts < 10000; ++attempts) {
            const int received = api.avcodec_receive_frame(codec, frame);
            if (received == 0) {
                if (hardware && frame->format != AV_PIX_FMT_D3D11) throw std::runtime_error("silent hardware decode fallback refused");
                if (hardware && transfer) {
                    require(api.av_hwframe_transfer_data(transferred, frame, 0), "transfer current frame");
                    return transferred;
                }
                return frame;
            }
            if (received != AVERROR(EAGAIN)) require(received, "receive exact source frame");
            if (draining) throw std::runtime_error("decoder stalled while draining");
            const int read = api.av_read_frame(format, packet);
            if (read == AVERROR_EOF) {
                require(api.avcodec_send_packet(codec, nullptr), "drain source decoder");
                draining = true;
            } else {
                require(read, "read source packet");
                if (packet->stream_index == stream) require(api.avcodec_send_packet(codec, packet), "submit source packet");
                api.av_packet_unref(packet);
            }
        }
        throw std::runtime_error("source packet work budget exceeded");
    }
    void pixels(AVFrame* picture, unsigned char* output) {
        if (picture->width != 3840 || picture->height != 2160) throw std::runtime_error("frozen source dimensions changed");
        if (!scaler) scaler = api.sws_getContext(picture->width, picture->height, static_cast<AVPixelFormat>(picture->format),
            32, 18, AV_PIX_FMT_RGB24, SWS_BICUBIC, nullptr, nullptr, nullptr);
        if (!scaler) throw std::runtime_error("comparison scaler allocation failed");
        unsigned char* destination[4] = { output, nullptr, nullptr, nullptr };
        const int strides[4] = { 32 * 3, 0, 0, 0 };
        if (api.sws_scale(scaler, picture->data, picture->linesize, 0, picture->height, destination, strides) != 18)
            throw std::runtime_error("incomplete comparison frame");
        api.av_frame_unref(frame); api.av_frame_unref(transferred);
    }
};

static std::string utf8(const wchar_t* value) {
    const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
    if (length < 1) throw std::runtime_error("invalid source path encoding");
    std::string result(length, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), length, nullptr, nullptr);
    result.pop_back();
    return result;
}

int wmain(int argc, wchar_t** argv) {
    std::shared_ptr<SurfaceLifecycle> observedSurfaces;
    const auto probeStarted = std::chrono::steady_clock::now();
    double setupSeconds = 0, decodeSeconds = 0, composeSeconds = 0, encodeSeconds = 0;
    int completedFrames = 0;
    int captionUploads = 0;
    uint64_t constantUploads = 0;
    const auto reportTimings = [&]() {
        fprintf(stderr, "private_stage_wall_seconds completedFrames=%d captionUploads=%d constantUploads=%llu setup=%.6f decode=%.6f compose=%.6f encode=%.6f total=%.6f\n",
            completedFrames, captionUploads, static_cast<unsigned long long>(constantUploads), setupSeconds, decodeSeconds, composeSeconds, encodeSeconds,
            std::chrono::duration<double>(std::chrono::steady_clock::now() - probeStarted).count());
    };
    try {
        const bool diagnostics = argc < 2 || wcscmp(argv[argc - 1], L"--no-comparison") != 0;
        const int argumentCount = argc - (diagnostics ? 0 : 1);
        if (argumentCount != 9 && argumentCount != 11 && argumentCount != 12 && argumentCount != 13) throw std::runtime_error("expected pinned-runtime source private-output readers frames hardware gpu-resize gpu-batch [shared-scene encoded-output [byte-budget [rgba-image]]] [--no-comparison]");
        const int readerCount = std::stoi(argv[4]), frameCount = std::stoi(argv[5]), hardware = std::stoi(argv[6]);
        const int gpu = std::stoi(argv[7]);
        const int batch = std::stoi(argv[8]);
        if ((readerCount != 1 && readerCount != 16) || (frameCount != 180 && frameCount != 1800) || (hardware != 0 && hardware != 1))
            throw std::runtime_error("private worker input budget invalid");
        if ((gpu != 0 && gpu != 1) || (gpu && !hardware)) throw std::runtime_error("GPU mode requires explicit hardware decode");
        if ((batch != 0 && batch != 1) || (batch && !gpu)) throw std::runtime_error("GPU batch requires explicit resize");
        const bool encode = argumentCount >= 11;
        const uint64_t encodedBudget = argumentCount >= 12 ? std::stoull(argv[11]) : 512ULL * 1024 * 1024;
        if (encode && !hardware) throw std::runtime_error("encoded fixture requires explicit hardware surfaces");
        NativeScene scene;
        if (encode) scene.open(argv[9], readerCount, frameCount);
        const bool compressedCaptions = scene.captions && argumentCount == 13 && wcscmp(argv[12], L"--caption-qtrle-stdin") == 0;
        if (scene.captions) {
            if (argumentCount != 13 || (!compressedCaptions && wcscmp(argv[12], L"--caption-premultiplied-rgba-stdin") != 0) || _setmode(_fileno(stdin), _O_BINARY) == -1)
                throw std::runtime_error("required caption stream contract mismatch");
        } else if (scene.mediaAlpha != (argumentCount == 13)) throw std::runtime_error("alpha scene/source argument contract mismatch");
        if (scene.overlap && (!encode || !gpu || !batch)) throw std::runtime_error("per-frame overlap requires bounded hardware batch encoding");
        if (!diagnostics && (!encode || !scene.overlap || !gpu || !batch))
            throw std::runtime_error("comparison can be disabled only when the shader owns encoded output");
        Api api; api.open(argv[1]);
        AVBufferRef* device = nullptr;
        if (hardware) require(api.av_hwdevice_ctx_create(&device, AV_HWDEVICE_TYPE_D3D11VA, "0", nullptr, 0), "create shared hardware device");
        auto releaseDevice = [&api](AVBufferRef* value) { api.av_buffer_unref(&value); };
        std::unique_ptr<AVBufferRef, decltype(releaseDevice)> deviceOwner(device, releaseDevice);
        const auto started = std::chrono::steady_clock::now();
        std::unique_ptr<GpuResize> reducer;
        if (gpu && diagnostics) reducer = std::make_unique<GpuResize>(api, device, batch ? readerCount : 1);
        std::unique_ptr<ShaderComposite> compositor;
        if (scene.overlap) compositor = std::make_unique<ShaderComposite>(api, device, readerCount, scene.mediaAlpha ? argv[12] : nullptr, scene.captions, compressedCaptions);
        std::unique_ptr<HardwareVideo> encoder;
        if (encode) {
            encoder = std::make_unique<HardwareVideo>(api);
            observedSurfaces = encoder->surfaceLifecycle;
            encoder->open(device, argv[10], encodedBudget);
        }
        std::vector<std::unique_ptr<Reader>> readers;
        int openedReaders = 0;
        for (int index = 0; index < readerCount; ++index) {
            if (scene.mediaAlpha && index > 0) { readers.push_back(nullptr); continue; }
            auto reader = std::make_unique<Reader>(api); reader->open(utf8(argv[2]), device); readers.push_back(std::move(reader));
            ++openedReaders;
        }
        FILE* file = nullptr;
        if (_wfopen_s(&file, argv[3], L"wb") != 0 || !file) throw std::runtime_error("private output unavailable");
        std::unique_ptr<FILE, decltype(&fclose)> output(file, fclose);
        std::vector<unsigned char> pixels(32 * 18 * 3);
        SIZE_T peakBytes = 0;
        uint64_t diagnosticPictures = 0;
        const auto checkMemory = [&peakBytes]() {
            PROCESS_MEMORY_COUNTERS counters{};
            if (!GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters))) throw std::runtime_error("memory measurement unavailable");
            peakBytes = (std::max)(peakBytes, counters.PeakWorkingSetSize);
            if (counters.WorkingSetSize > 4ULL * 1024 * 1024 * 1024) throw std::runtime_error("private decoder memory guard exceeded");
        };
        setupSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - probeStarted).count();
        for (int frameIndex = 0; frameIndex < frameCount; ++frameIndex) {
            if (std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count() > 115)
                throw std::runtime_error("private decoder deadline exceeded");
            AVFrame* canvasFrame = encoder ? encoder->acquire(frameIndex) : nullptr;
            if (batch) {
                const auto decodeStarted = std::chrono::steady_clock::now();
                for (int index = 0; index < readerCount; ++index) {
                    if (!readers[index]) continue;
                    if (frameIndex && frameIndex % 180 == 0) readers[index]->rewind();
                    AVFrame* decoded = readers[index]->next(true, false);
                    if (reducer) reducer->submit(decoded, index);
                }
                decodeSeconds += std::chrono::duration<double>(std::chrono::steady_clock::now() - decodeStarted).count();
            }
            if (compositor) {
                const auto composeStarted = std::chrono::steady_clock::now();
                std::vector<AVFrame*> current;
                for (const auto& reader : readers) current.push_back(reader ? reader->frame : nullptr);
                compositor->compose(canvasFrame, current, scene, frameIndex);
                captionUploads = compositor->captionUploads;
                constantUploads = compositor->constantUploads;
                composeSeconds += std::chrono::duration<double>(std::chrono::steady_clock::now() - composeStarted).count();
            }
            if (!diagnostics) {
                const auto encodeStarted = std::chrono::steady_clock::now();
                encoder->submit();
                encodeSeconds += std::chrono::duration<double>(std::chrono::steady_clock::now() - encodeStarted).count();
                for (const auto& reader : readers) {
                    if (!reader) continue;
                    api.av_frame_unref(reader->frame); api.av_frame_unref(reader->transferred);
                }
                checkMemory();
                completedFrames = frameIndex + 1;
                continue;
            }
            for (int index = 0; index < readerCount; ++index) {
                auto& reader = readers[index];
                if (!reader) {
                    std::fill(pixels.begin(), pixels.end(), 0);
                    if (fwrite(pixels.data(), 1, pixels.size(), output.get()) != pixels.size()) throw std::runtime_error("private static-image diagnostic write failed");
                    continue;
                }
                if (!batch && frameIndex && frameIndex % 180 == 0) reader->rewind();
                AVFrame* decoded = batch ? reader->frame : reader->next(hardware != 0, !gpu && !encode);
                if (encoder && !compositor) {
                    auto context = static_cast<AVD3D11VADeviceContext*>(reinterpret_cast<AVHWDeviceContext*>(device->data)->hwctx);
                    const auto& placement = scene.placements.at(index);
                    if (placement.reader != index) throw std::runtime_error("shared fixture reader ordering differs");
                    ID3D11Texture2D* source = reducer ? reducer->slots.at(batch ? index : 0).reduced.Get()
                        : reinterpret_cast<ID3D11Texture2D*>(decoded->data[0]);
                    if (reducer && !batch) reducer->submit(decoded, 0);
                    const UINT sourceSlice = reducer ? 0 : static_cast<UINT>(reinterpret_cast<uintptr_t>(decoded->data[1]));
                    const UINT destinationSlice = static_cast<UINT>(reinterpret_cast<uintptr_t>(canvasFrame->data[1]));
                    const D3D11_BOX sourceBox = { 0, 0, 0, placement.width, placement.height, 1 };
                    context->device_context->CopySubresourceRegion(reinterpret_cast<ID3D11Texture2D*>(canvasFrame->data[0]),
                        destinationSlice, placement.x, placement.y, 0, source, sourceSlice, &sourceBox);
                    require(context->device->GetDeviceRemovedReason(), "GPU output device state");
                    if (!gpu) {
                        require(api.av_hwframe_transfer_data(reader->transferred, decoded, 0), "comparison-only source readback");
                        reader->pixels(reader->transferred, pixels.data());
                    }
                }
                if (reducer) {
                    if (!batch) reducer->submit(decoded, 0);
                    reducer->read(batch ? index : 0, pixels.data());
                    api.av_frame_unref(reader->frame); api.av_frame_unref(reader->transferred);
                } else if (!encode) { reader->pixels(decoded, pixels.data()); }
                if (fwrite(pixels.data(), 1, pixels.size(), output.get()) != pixels.size()) throw std::runtime_error("private frame write failed");
                ++diagnosticPictures;
                checkMemory();
            }
            if (encoder) encoder->submit();
            completedFrames = frameIndex + 1;
        }
        if (scene.captions) {
            const bool extra = compositor->captionDecoder ? compositor->captionDecoder->next(frameCount) != nullptr : fgetc(stdin) != EOF;
            if (compositor->captionFrames != frameCount || extra) throw std::runtime_error("required caption stream frame count differs");
        }
        if (encoder) {
            encoder->finish();
            if (encoder->encodedPackets != frameCount) throw std::runtime_error("encoder packet/frame count mismatch");
            encoder->close();
            if (!encoder->surfaceLifecycle->bankReleased || encoder->surfaceLifecycle->texturesReleased != 3 ||
                encoder->surfaceLifecycle->descriptorsReleased != encoder->surfaceLifecycle->issued)
                throw std::runtime_error("encoder output surfaces remain owned after completion");
        }
        if (fflush(output.get()) != 0) throw std::runtime_error("private frame flush failed");
        const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
        reportTimings();
        printf("{\"status\":\"artifact_pending\",\"readers\":%d,\"frames\":%d,\"hardware\":%s,\"gpuResize\":%s,\"gpuBatch\":%s,\"encode\":%s,\"overlap\":%s,\"encodedBytes\":%llu,\"seconds\":%.6f,\"peakWorkingSetBytes\":%llu,\"decoderOpens\":%d,\"captionFrames\":%d,\"diagnostics\":%s,\"diagnosticPictures\":%llu,\"maxGpuInputStreams\":%u,\"maxGpuStreamStates\":%u,\"outputTextures\":%llu,\"outputDescriptors\":%llu,\"refusedSurfaceGrowth\":%llu,\"surfaceExhaustionVerified\":%s,\"outputTexturesReleased\":%llu,\"outputDescriptorsReleased\":%llu,\"outputBankReleased\":%s,\"comparisonWidth\":32,\"comparisonHeight\":18}\n",
            readerCount, frameCount, hardware ? "true" : "false", gpu ? "true" : "false", batch ? "true" : "false", encode ? "true" : "false",
            compositor ? "true" : "false", encoder ? encoder->encodedBytes : 0, seconds, static_cast<unsigned long long>(peakBytes), openedReaders,
            compositor ? compositor->captionFrames : 0,
            diagnostics ? "true" : "false", diagnosticPictures,
            reducer ? reducer->capabilities.MaxInputStreams : 0, reducer ? reducer->capabilities.MaxStreamStates : 0,
            encoder ? encoder->surfaceLifecycle->created.load() : 0, encoder ? encoder->surfaceLifecycle->issued.load() : 0, encoder ? encoder->surfaceLifecycle->exhausted.load() : 0,
            encoder && encoder->surfaceExhaustionVerified ? "true" : "false", encoder ? encoder->surfaceLifecycle->texturesReleased.load() : 0,
            encoder ? encoder->surfaceLifecycle->descriptorsReleased.load() : 0, encoder && encoder->surfaceLifecycle->bankReleased.load() ? "true" : "false");
        return 0;
    } catch (const std::exception& error) {
        reportTimings();
        fprintf(stderr, "private native worker failed: %s\n", error.what());
        if (observedSurfaces) {
            printf("{\"status\":\"failed\",\"outputTextures\":%llu,\"outputDescriptors\":%llu,\"outputTexturesReleased\":%llu,\"outputDescriptorsReleased\":%llu,\"outputBankReleased\":%s}\n",
                observedSurfaces->created.load(), observedSurfaces->issued.load(), observedSurfaces->texturesReleased.load(),
                observedSurfaces->descriptorsReleased.load(), observedSurfaces->bankReleased.load() ? "true" : "false");
        }
        return 1;
    }
}