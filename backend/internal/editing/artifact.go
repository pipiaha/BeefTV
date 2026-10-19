package editing

import "fmt"

// RenderArtifact describes the durable local artifact selected by a compiled
// output. Callers use it for both encoding and generation-artifact recovery.
func RenderArtifact(output Output) (kind, fileName, mimeType string, err error) {
	if output.Output == "" && output.Format == "" {
		output.Output = OutputVideo
		output.Format = FormatMP4
	}
	switch output.Output {
	case OutputVideo:
		if output.Format != FormatMP4 {
			return "", "", "", ErrInvalidOutput
		}
		return KindVideo, "timeline-render.mp4", "video/mp4", nil
	case OutputAudio:
		if output.Format == FormatWAV {
			return KindAudio, "timeline-render.wav", "audio/wav", nil
		}
		if output.Format == FormatMP3 {
			return KindAudio, "timeline-render.mp3", "audio/mpeg", nil
		}
		return "", "", "", ErrInvalidOutput
	case OutputImage:
		if output.Format == FormatPNG {
			return KindImage, "contact-sheet.png", "image/png", nil
		}
		if output.Format == FormatJPEG {
			return KindImage, "contact-sheet.jpg", "image/jpeg", nil
		}
		return "", "", "", ErrInvalidOutput
	default:
		return "", "", "", fmt.Errorf("%w：未知导出类型", ErrInvalidOutput)
	}
}
