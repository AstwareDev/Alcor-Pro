// Generated from Swift ToolDefinitions.swift helper functions; strings are verbatim.
import { textStyleAxisScaleRange, transformTiltRotationRange } from "../../../model";
import type { JsonObject } from "../toolRegistry";

type Properties = Record<string, JsonObject>;

export function textTransformProperties(): Properties {
  return {
            "x": {"type": "number", "description": "Normalized horizontal anchor of the unrotated text box: the left edge for left alignment, center for center alignment, or right edge for right alignment."},
            "y": {"type": "number", "description": "Normalized vertical center."},
            "rotation": {"type": "number", "description": "Clockwise Z-axis degrees."},
            "rotationX": {"type": "number", "minimum": transformTiltRotationRange.min, "maximum": transformTiltRotationRange.max, "description": "Static X-axis perspective rotation in degrees. Positive tips the top edge away from the viewer."},
            "rotationY": {"type": "number", "minimum": transformTiltRotationRange.min, "maximum": transformTiltRotationRange.max, "description": "Static Y-axis perspective rotation in degrees. Positive brings the right edge toward the viewer."},
        };
}

function textStyleDetailed(): Properties {
  return {
            "style": {
                "type": "object",
                "description": "Partial text-style patch. Omitted properties keep existing values (updates) or the app's default style (new text and captions). Set only what the user asked for; omit the whole object when they didn't specify a look.",
                "properties": {
                    "fontName": {"type": "string", "description": "Font PostScript name."},
                    "fontSize": {"type": "number", "minimum": 12, "maximum": 300, "description": "Font size in canvas points."},
                    "widthScale": {"type": "number", "minimum": textStyleAxisScaleRange.min, "maximum": textStyleAxisScaleRange.max, "description": "Glyph width multiplier. 1 preserves the font's original width."},
                    "heightScale": {"type": "number", "minimum": textStyleAxisScaleRange.min, "maximum": textStyleAxisScaleRange.max, "description": "Glyph height multiplier. 1 preserves the font's original height."},
                    "bold": {"type": "boolean", "description": "Bold font trait."},
                    "italic": {"type": "boolean", "description": "Italic font trait."},
                    "underline": {"type": "boolean", "description": "Draw a line below the text."},
                    "strikethrough": {"type": "boolean", "description": "Draw a line through the text."},
                    "overline": {"type": "boolean", "description": "Draw a line above the text."},
                    "tracking": {"type": "number", "minimum": -20, "maximum": 100, "description": "Spacing between characters in canvas points."},
                    "lineSpacing": {"type": "number", "minimum": -100, "maximum": 300, "description": "Additional spacing between lines in canvas points."},
                    "fontCase": {"type": "string", "enum": ["mixed", "uppercase", "lowercase"], "description": "Non-destructive display casing."},
                    "alignment": {"type": "string", "enum": ["left", "center", "right"], "description": "Text alignment."},
                    "color": {"type": "string", "description": "Text color as #RGB, #RRGGBB, or #RRGGBBAA."},
                    "blur": {"type": "number", "minimum": 0, "maximum": 100, "description": "Whole-layer Gaussian blur in 1080p canvas pixels. Blurs glyphs, outline, shadow, and background; 0 removes it."},
                    "outline": {
                        "type": "object",
                        "properties": {
                            "enabled": {"type": "boolean"},
                            "color": {"type": "string", "description": "Outline color hex."},
                            "width": {"type": "number", "minimum": 0, "maximum": 40, "description": "Width in canvas points."},
                        },
                    },
                    "shadow": {
                        "type": "object",
                        "properties": {
                            "enabled": {"type": "boolean"},
                            "color": {"type": "string", "description": "Shadow color hex. Six-digit colors preserve the current opacity."},
                            "opacity": {"type": "number", "minimum": 0, "maximum": 1},
                            "offset": {
                                "type": "object",
                                "properties": {
                                    "x": {"type": "number", "minimum": -200, "maximum": 200},
                                    "y": {"type": "number", "minimum": -200, "maximum": 200},
                                },
                            },
                            "blur": {"type": "number", "minimum": 0, "maximum": 100, "description": "Blur radius in canvas points."},
                        },
                    },
                    "background": {
                        "type": "object",
                        "properties": {
                            "enabled": {"type": "boolean"},
                            "color": {"type": "string", "description": "Background color hex. Six-digit colors preserve the current opacity."},
                            "opacity": {"type": "number", "minimum": 0, "maximum": 1},
                            "padding": {
                                "type": "object",
                                "properties": {
                                    "x": {"type": "number", "minimum": 0, "maximum": 300},
                                    "y": {"type": "number", "minimum": 0, "maximum": 300},
                                },
                            },
                            "center": {
                                "type": "object",
                                "properties": {
                                    "x": {"type": "number", "minimum": -500, "maximum": 500},
                                    "y": {"type": "number", "minimum": -500, "maximum": 500},
                                },
                            },
                            "cornerRadius": {"type": "number", "minimum": 0, "maximum": 300, "description": "Corner radius in canvas points."},
                            "outline": {
                                "type": "object",
                                "properties": {
                                    "color": {"type": "string", "description": "Background outline color hex."},
                                    "width": {"type": "number", "minimum": 0, "maximum": 40, "description": "Background outline width in canvas points."},
                                },
                            },
                        },
                    },
                },
            },
        };
}

function schemaWithoutDescriptions(schema: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description") continue;
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item) ? schemaWithoutDescriptions(item) : item,
      );
    } else if (typeof value === "object" && value !== null) {
      result[key] = schemaWithoutDescriptions(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function textStyleProperties(detailed: boolean): Properties {
  const properties = textStyleDetailed();
  if (detailed) return properties;
  const style = schemaWithoutDescriptions(properties.style);
  style.description =
    "Same partial style patch as update_text. Omit entirely unless the user asked for specific styling; omitted = app default style.";
  return { style };
}

export function mergedProperties(...chunks: Properties[]): Properties {
  return Object.assign({}, ...chunks);
}
