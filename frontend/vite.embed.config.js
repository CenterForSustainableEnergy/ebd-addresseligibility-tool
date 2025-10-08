import { defineConfig } from "vite";

// This config builds a standalone, embeddable JS file.
export default defineConfig({
	build: {
		lib: {
			entry: "embed/lookup-widget.js", // widget file
			name: "EBDLookup",
			fileName: () => "lookup-widget.min.js",
			formats: ["iife"], // Immediately Invoked Function Expression
		},
		outDir: "dist/embed",
		emptyOutDir: false, // don’t clear dist for the main app
		minify: true,
	},
});
