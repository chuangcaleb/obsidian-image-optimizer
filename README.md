# Obsidian Image Optimizer

A simple image optimizer to (1) compress, (2) slugify, (3) content hash.

## Features

What this plugin does:

- Compress images
  - (greatly reduce redundant file size, while preserving quality)
  - (bring your own code — see [usage](#usage) below)
- Rename image file
  - Slugify filename (for SEO-friendly resource names)
  - Append a hash (based on file content, for cache busting)
  - Updates all references of the old image filename/path
- Triggers:
  - Automatically, when new image file is added to the vault (e.g. drag and dropped into a note)
  - Manually, via command: "Rename and Compress Active Image"

What this plugin doesn't do:

- Image transformation (other than compression)
- Create responsive variants (e.g. creating duplicate files at 64x64, 256x256, etc.)

## Disclaimer

This plugin uses a technical workaround for image compression. You will need minor tech literacy to get the plugin to work.

Also goes to say. Only use this plugin if you know what you're doing. You will involve a custom script, so please don't blindly copy-paste arbitrary untrusted code and execute it.

This plugin is also DESTRUCTIVE, since it deletes the unoptimized file after the optimized version is created. Do not use without reliable backup (or unless you know what you're doing).

I threw this plugin together sloppily for my personal use case. I don't bother to make it airtight. Please try it out first on an empty vault, and then still use with reasonable caution.

## Usage

You may open the Obsidian vault at `obsidian-image-optimizer-test` directory from this repository, and explore there. If not, follow these steps.

1. Create or open existing Obsidian vault.
2. Install Obsidian plugin, unofficially, through [BRAT](https://github.com/TfTHacker/obsidian42-brat)
3. Install an image compression script, somewhere in your vault (see below)
4. Navigate to Image Optimizer plugin settings, and fil in `Absolute path to runtime` and `Absolute path to compression script`

You now have two methods of optimizing images:

Manual

1. Open an existing image
2. Run command `Image Optimizer: Optimize active image file`
3. Wait... Profit.

Automatic

1. Enable `Trigger automatically` in plugin settings
2. Drag and drop a new image into a note (or manually drag it into Obsidian's File Explorer)
3. Wait... Profit.

### How to install image compression script

1. Create a folder somewhere in your vault (e.g. at `./scripts/compress/`)
2. Put your compression script files inside. You may copy over files from the example provided at `obsidian-image-optimizer-test/scripts/compress`.
3. Make sure to install any required dependencies. Run `pnpm install`.

### How to fill in the "Absolute path" settings

For `Absolute path to runtime`, if you are using the example script, then you are using a `node` runtime. Enter the result of this:

```shell
which node
# e.g. /Users/chuangcaleb/.nvm/versions/node/v20.12.2/bin/node
# e.g. /opt/homebrew/bin/node
```

For `Absolute path to compression script`,

1. Find the entry point file. In the case of the example, it is the `scripts/compress/index.js`
2. Copy its absolute filepath (should start with a slash `/`).
3. Paste this value into the field.

## Use Case

I use Obsidian to author blog posts. I store images in a directory, which is synced to a S3 bucket, which in turn exposes a URL resource on a page of my blog site.

I want to upload pre-compressed images, ready for the web, even before uploading the images to the cloud (this saves on expensive network egress AND takes less space on your storage!). Files already slugified on the bucket, means that the CDN doesn't need to preprocess further. Then, appending a hash (based on content) allows the cache busting strategy.

I will also use this plugin to compress the images that I'm not exposing to the public web. Compressing your images by default is virtually always good. Takes up less space in your device storage and during cloud sync.

## Technical Challenge

### Explanation

I thought there would be an existing plugin out there. Or Templater user script. I tried making one. Turns out, pain point with the `compression` step

`sharp` is a native Node.js module with binary dependencies. Obsidian plugins run inside Electron, so Node APIs are allowed. But Obsidian does not bundle or load native modules like `sharp` for plugins. So: you can't use sharp in an Obsidian plugin directly — even if it's in your package.json. This is due to safety, and whatever.

I tried alternatives. The HTML Canvas trick did not compress nearly as much as `sharp` could. Then `@squoosh/lib` didn't work either, needed some WASM binding. A `node` server could also be running `sharp`, but overengineering!!

### Solution - Bring your own code

We can still, within native `node` runtime, make an `exec` call to a custom `node` script to compress our images. We can step out for a while, then step back in!

The user will need to bring their own script, powered by `sharp`, or other compressor. This will raise barrier to entry with technical literacy. But it makes it possible.

### Waiting for metadata cache

Issue: If we rename the file right away, the file will be renamed, but the references in markdown notes, won't. This is because we need to wait for metadata cache to be ready. This is why there is a delay when the processing is triggered. But you can safely leave it to run in the background.

## Contributing & Maintenance

I am the solo-maintainer of [obsidian-fountain-editor](https://github.com/chuangcaleb/obsidian-fountain-editor), besides having a full-time job and a bunch of other technical and non-technical projects. And have a life.

As it stands, this plugin does everything I need, a simple pre-processing step. I don't plan on taking feature requests, but will gladly take bug reports and pull requests!

For now, I won't publish to the official Obsidian community plugin store, because that's too much exposure and pressure to handle this plugin. So install through BRAT. I am happy to have someone else take over—message me!

## Future Enhancements

If I ever fel like it. Or if someone wants to open a PR.

- Setting toggle for globally enabling/disabling each of the three steps (compress, slugify, hash)
- Custom runtimes?
- Custom excludes for new images, if auto file watcher is enabled
- Airtight edge case/error handling

Definitely ones I'm too lazy to do, but would be amazing QOL

- Custom filename tempalte formats
- Allow custom compression args
- Open a Obsidian suggester prompt per-image triggered, for skipping certain steps or configuring compression (e.g. don't slugify this image)

## Related Plugins

> [!NOTE] Obsidian Image Converter plugin
> [xRyul/obsidian-image-converter: ⚡️ Convert, compress, resize, annotate, markup, draw, crop, rotate, flip, align images directly in Obsidian. Drag-resize, rename with variables, batch process. WEBP, JPG, PNG, HEIC, TIF.](https://github.com/xryul/obsidian-image-converter)
>
> - Full toolkit for image transformations like annotations, drawing, cropping. So much more out of scope
> - `webp` compression uses HTML Canvas trick, which is not as optimal/tunable as `sharp` (or whatever else, really)

> [!NOTE] Obsidian Paste Image Rename plugin
> obsidian://show-plugin?id=obsidian-paste-image-rename
> Only handles file renames, if that's all you need. Interesting idea for name templates per-note
