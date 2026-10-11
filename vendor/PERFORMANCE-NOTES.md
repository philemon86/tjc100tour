# Local performance changes to Pannellum 2.5.6

The bundled renderer retains the upstream MIT license in PANNELLUM-LICENSE.txt.

- Static equirectangular scenes accept an optional `preloadedImage` containing an already loaded and decoded HTMLImageElement. Initialization is deferred to the next task so the viewer's load listeners can be registered. URL loading remains available as a fallback. This does not enable the dynamic renderer or upload textures every animation frame.
- Scene fading copies the rendered perspective into a canvas with `drawImage`, preserving the existing fade behavior while avoiding synchronous PNG encoding, base64 allocation and decoding that PNG before starting the next scene. The fade canvas is removed by the existing fade completion code.

The application shares pending image requests and retains at most two decoded panoramas on mobile and three on desktop, including the current scene. Eviction also clears the scene configuration's reference. Exhibit images use separate bounded caching and smaller WebP variants; original JPG files remain available for detailed reading.
