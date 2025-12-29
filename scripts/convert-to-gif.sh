#!/bin/bash
# Convert screen recording to GIF for README
# Usage: ./convert-to-gif.sh input.mov output.gif

INPUT="$1"
OUTPUT="$2"
FPS="${3:-10}"
WIDTH="${4:-800}"

if [ -z "$INPUT" ] || [ -z "$OUTPUT" ]; then
    echo "Usage: $0 input.mov output.gif [fps] [width]"
    echo "Example: $0 ~/Desktop/recording.mov images/validation.gif 10 800"
    exit 1
fi

ffmpeg -i "$INPUT" \
    -vf "fps=$FPS,scale=$WIDTH:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
    -loop 0 \
    "$OUTPUT"

echo "Created: $OUTPUT"
ls -lh "$OUTPUT"
