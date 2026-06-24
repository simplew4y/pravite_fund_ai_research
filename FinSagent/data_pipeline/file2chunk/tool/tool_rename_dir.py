import os
from pathlib import Path

def rename_files_in_subfolders(base_path):
    base_dir = Path(base_path)
    
    # Iterate over each sub-folder in the base directory
    for subfolder in base_dir.iterdir():
        if not subfolder.is_dir():
            continue
            
        # Target the 'auto' directory if it exists, otherwise use the subfolder itself
        target_dir = subfolder / 'auto'
        if not target_dir.exists():
            target_dir = subfolder
            
        # Get all files in the target directory (ignores sub-directories like 'images')
        files = [f for f in target_dir.iterdir() if f.is_file()]
        
        if not files:
            continue
            
        # Dynamically find the old prefix. 
        # Looking for the .md file is the most reliable method for this specific data structure.
        md_files = list(target_dir.glob("*.md"))
        if md_files:
            old_prefix = md_files[0].stem  # e.g., 'memorandum_20231109'
        else:
            # Fallback: use the longest common prefix among all files in the folder
            file_names = [f.name for f in files]
            old_prefix = os.path.commonprefix(file_names).rstrip('._')
        
        if not old_prefix:
            print(f"Skipping '{subfolder.name}': Could not determine a valid prefix.")
            continue
            
        new_prefix = subfolder.name
        
        print(f"\nProcessing subfolder: {subfolder.name}")
        print(f"Found old prefix: '{old_prefix}'")
        
        # Rename the files
        for file_path in files:
            # Only rename if the file actually starts with the old prefix
            if file_path.name.startswith(old_prefix):
                # Replace the prefix (using count=1 to only replace the first occurrence)
                new_filename = file_path.name.replace(old_prefix, new_prefix, 1)
                new_file_path = target_dir / new_filename
                
                # Perform the rename
                file_path.rename(new_file_path)
                print(f"  Renamed: {file_path.name} -> {new_filename}")

if __name__ == "__main__":
    # Your target base directory containing the processed_pdf subfolders
    base_directory = "/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/processed_pdf"
    
    print(f"Starting rename process in: {base_directory}")
    rename_files_in_subfolders(base_directory)
    print("\nProcess completed.")
