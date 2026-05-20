import sys
import os
from PIL import Image

def process_portrait(input_path, agent_id, output_dir):
    if not os.path.exists(input_path):
        print(f"Error: input file {input_path} does not exist")
        sys.exit(1)

    if not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    img = Image.open(input_path)
    print(f"Opened input image: {input_path} (size={img.size}, mode={img.mode})")

    # Destination paths
    hero_path = os.path.join(output_dir, f"{agent_id}.png")
    thumb_path = os.path.join(output_dir, f"{agent_id}@128.png")

    # Resize to 512x512
    hero_img = img.resize((512, 512), Image.Resampling.LANCZOS)
    # Resize to 128x128
    thumb_img = img.resize((128, 128), Image.Resampling.LANCZOS)

    # Scrub metadata by creating a new clean image for each
    for label, processed_img, dest_path in [("hero", hero_img, hero_path), ("thumbnail", thumb_img, thumb_path)]:
        # Quantize to 128 colors to meet the performance budget
        quantized = processed_img.quantize(colors=128)
        
        # Create a new image of the same size and mode but with no metadata
        clean_img = Image.new(quantized.mode, quantized.size)
        clean_img.putdata(list(quantized.getdata()))
        if quantized.mode == "P":
            clean_img.putpalette(quantized.getpalette())
        
        # Save with high compression and optimization, no metadata
        clean_img.save(dest_path, format="PNG", optimize=True, compress_level=9)
        print(f"Saved scrubbed {label} to {dest_path} (size={clean_img.size}, bytes={os.path.getsize(dest_path)})")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python scripts/process_agent_portrait.py <input_path> <agent_id> [output_dir]")
        sys.exit(1)
        
    input_path = sys.argv[1]
    agent_id = sys.argv[2]
    output_dir = sys.argv[3] if len(sys.argv) > 3 else "packages/spatial-war-room/public/agents"
    
    process_portrait(input_path, agent_id, output_dir)
