#!/usr/bin/env ruby
require "json"
require "fileutils"

# Read the manifest
file = File.read("extension/manifest.json")
manifest = JSON.parse(file)
version = manifest["version"].gsub(".", "_")
name = manifest["name"].downcase.split.join("_")

new_name = "#{name}_v#{version}.zip"

`zip -r #{new_name} extension/* -x "*.zip" "node_modules/*" "package-lock.json" ".eslintcache" ".directory"`
puts "Created #{new_name}"
