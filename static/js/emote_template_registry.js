/*
 * Renderer-neutral template registry.
 *
 * EmoteLab is one provider; future N.E.K.O. templates should implement the
 * same package contract instead of adding another set of raster-only globals.
 * The registry does not load binary assets.  A renderer owns that decision.
 */
(function (root) {
    'use strict';

    const providers = new Map();

    function register(provider) {
        if (!provider || !provider.id || typeof provider.accept !== 'function') {
            throw new TypeError('A template provider needs an id and accept()');
        }
        providers.set(provider.id, provider);
        return provider;
    }

    function resolve(packageManifest) {
        for (const provider of providers.values()) {
            if (provider.accept(packageManifest)) return provider;
        }
        return null;
    }

    function capabilities(packageManifest) {
        const provider = resolve(packageManifest);
        return provider && typeof provider.capabilities === 'function'
            ? provider.capabilities(packageManifest)
            : {
                metadata: false,
                spineRender: false,
                nativeExport: false,
                staticPngExport: false,
                animatedExport: false,
                sceneOutline: true,
                sceneText: true,
                sceneOverlay: 'canvas2d-compatible',
            };
    }

    root.NekoEmoteTemplateRegistry = Object.freeze({
        register,
        resolve,
        capabilities
    });

    register({
        id: 'emotelab',
        accept: (manifest) => manifest?.schemaVersion === 1 && manifest?.source?.kind === 'emotelab',
        capabilities: (manifest) => manifest?.capabilities || {
            metadata: true,
            spineRender: false,
            nativeExport: false,
            staticPngExport: false,
            animatedExport: false,
            sceneOutline: true,
            sceneText: true,
            sceneOverlay: 'canvas2d-compatible',
        }
    });
}(window));
