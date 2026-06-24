#!/bin/bash

# Define source and destination
SOURCE_DIR="/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/final_pdf"
DEST_DIR="/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/base_final"

# Create destination directory if it doesn't exist
mkdir -p "$DEST_DIR"

# Loop through each subdirectory and copy the file
for file in "$SOURCE_DIR"/*/base_final.json; do
    # Check if the file actually exists (handles empty glob)
    if [ -f "$file" ]; then
        # Get the name of the parent folder to make the filename unique
        # e.g., .../folder1/base_final.json -> folder1_base_final.json
        parent_dir=$(basename "$(dirname "$file")")
        
        cp "$file" "$DEST_DIR/${parent_dir}_base_final.json"
        echo "Copied: $parent_dir"
    fi
done

echo "Done! All files are in $DEST_DIR"
