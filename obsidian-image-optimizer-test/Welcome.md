Welcome to the test vault!

Before this plugin is functional, you need to know/do the following:

This plugin needs an external `compress` script to work.

The compress script can be found at the `scripts/compress` directory, but you can move it anywhere, really — just make sure to update the `Absolute path to compression script` plugin setting.

If you are using the suggested script at `scripts/compress`, you must also first install the `sharp` npm package. Do this:

```shell
# make sure you are running this terminal from Obsidian vault root

cd ./scripts/compress # or whatever location
pnpm install # or npm, or yarn, or whatever
```

 Next, you must fill in both "Absolute path" settings in plugin settings. Refer to the plugin's main README.

If you are all done, then you can either 
1. Run the `Image Optimizer: Optimize active image file` command
2. Enable `Trigger Automatically` plugin setting, and drag and drop an image below

