//! Canonical Hancom equation-script output for newly edited LaTeX input.

use super::ast::{EqNode, MatrixStyle, PileAlign, SpaceKind};
use super::symbols::{DecoKind, FontStyleKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalScriptError {
    UnsupportedFontStyle(FontStyleKind),
}

pub fn to_hwp_script(node: &EqNode) -> Result<String, CanonicalScriptError> {
    let mut output = String::new();
    write_node(node, &mut output)?;
    Ok(output.trim().to_string())
}

fn group(node: &EqNode) -> Result<String, CanonicalScriptError> {
    Ok(format!("{{{}}}", to_hwp_script(node)?))
}

fn write_node(node: &EqNode, output: &mut String) -> Result<(), CanonicalScriptError> {
    match node {
        EqNode::Row(children) => {
            for child in children {
                let text = to_hwp_script(child)?;
                if text.is_empty() {
                    continue;
                }
                if !output.is_empty() && !output.ends_with([' ', '~', '`', '&', '#']) {
                    output.push(' ');
                }
                output.push_str(&text);
            }
        }
        EqNode::Text(text) => write_text(text, output),
        EqNode::Number(text) | EqNode::Symbol(text) | EqNode::Function(text) => {
            output.push_str(text)
        }
        EqNode::MathSymbol(symbol) => output.push_str(math_symbol_name(symbol)),
        EqNode::Fraction { numer, denom } => {
            output.push_str(&group(numer)?);
            output.push_str(" over ");
            output.push_str(&group(denom)?);
        }
        EqNode::Atop { top, bottom } => {
            output.push_str(&group(top)?);
            output.push_str(" atop ");
            output.push_str(&group(bottom)?);
        }
        EqNode::Sqrt { index, body } => {
            if let Some(index) = index {
                output.push_str("root ");
                output.push_str(&group(index)?);
                output.push_str(" of ");
            } else {
                output.push_str("sqrt ");
            }
            output.push_str(&group(body)?);
        }
        EqNode::Superscript { base, sup } => {
            output.push_str(&group(base)?);
            output.push('^');
            output.push_str(&group(sup)?);
        }
        EqNode::Subscript { base, sub } => {
            output.push_str(&group(base)?);
            output.push('_');
            output.push_str(&group(sub)?);
        }
        EqNode::SubSup { base, sub, sup } => {
            output.push_str(&group(base)?);
            output.push('_');
            output.push_str(&group(sub)?);
            output.push('^');
            output.push_str(&group(sup)?);
        }
        EqNode::BigOp { symbol, sub, sup } => {
            output.push_str(big_operator_name(symbol));
            if let Some(sub) = sub {
                output.push('_');
                output.push_str(&group(sub)?);
            }
            if let Some(sup) = sup {
                output.push('^');
                output.push_str(&group(sup)?);
            }
        }
        EqNode::Limit { is_upper, sub } => {
            output.push_str(if *is_upper { "Lim" } else { "lim" });
            if let Some(sub) = sub {
                output.push('_');
                output.push_str(&group(sub)?);
            }
        }
        EqNode::Matrix { rows, style } => {
            output.push_str(match style {
                MatrixStyle::Plain => "matrix",
                MatrixStyle::Paren => "pmatrix",
                MatrixStyle::Bracket => "bmatrix",
                MatrixStyle::Vert => "dmatrix",
            });
            output.push_str(" {");
            for (row_index, row) in rows.iter().enumerate() {
                if row_index > 0 {
                    output.push_str(" # ");
                }
                for (column_index, cell) in row.iter().enumerate() {
                    if column_index > 0 {
                        output.push_str(" & ");
                    }
                    output.push_str(&to_hwp_script(cell)?);
                }
            }
            output.push('}');
        }
        EqNode::Cases { rows } => write_rows("cases", rows, output)?,
        EqNode::Pile { rows, align } => write_rows(
            match align {
                PileAlign::Center => "pile",
                PileAlign::Left => "lpile",
                PileAlign::Right => "rpile",
            },
            rows,
            output,
        )?,
        EqNode::EqAlign { rows } => {
            output.push_str("eqalign {");
            for (index, (left, right)) in rows.iter().enumerate() {
                if index > 0 {
                    output.push_str(" # ");
                }
                output.push_str(&to_hwp_script(left)?);
                output.push_str(" & ");
                output.push_str(&to_hwp_script(right)?);
            }
            output.push('}');
        }
        EqNode::Rel { arrow, over, under } => {
            output.push_str(if under.is_some() { "rel " } else { "buildrel " });
            output.push_str(arrow);
            output.push(' ');
            output.push_str(&group(over)?);
            if let Some(under) = under {
                output.push(' ');
                output.push_str(&group(under)?);
            }
        }
        EqNode::Paren { left, right, body } => {
            output.push_str("left ");
            output.push_str(bracket_name(left, true));
            output.push(' ');
            output.push_str(&to_hwp_script(body)?);
            output.push_str(" right ");
            output.push_str(bracket_name(right, false));
        }
        EqNode::Decoration { kind, body } => {
            output.push_str(decoration_name(*kind));
            output.push(' ');
            output.push_str(&group(body)?);
        }
        EqNode::FontStyle { style, body } => {
            let name = match style {
                FontStyleKind::Roman => "rm",
                FontStyleKind::Italic => "it",
                FontStyleKind::Bold => "bold",
                unsupported => {
                    return Err(CanonicalScriptError::UnsupportedFontStyle(*unsupported))
                }
            };
            output.push_str(name);
            output.push(' ');
            output.push_str(&group(body)?);
        }
        EqNode::Color { r, g, b, body } => {
            output.push_str(&format!("color {{{r},{g},{b}}} "));
            output.push_str(&group(body)?);
        }
        EqNode::Space(SpaceKind::Normal) => output.push('~'),
        EqNode::Space(SpaceKind::Thin) => output.push('`'),
        EqNode::Space(SpaceKind::Tab) => output.push('&'),
        EqNode::Newline => output.push('#'),
        EqNode::Quoted(text) => {
            output.push('"');
            output.push_str(&text.replace('"', "\\\""));
            output.push('"');
        }
        EqNode::Empty => {}
    }
    Ok(())
}

fn write_rows(
    command: &str,
    rows: &[EqNode],
    output: &mut String,
) -> Result<(), CanonicalScriptError> {
    output.push_str(command);
    output.push_str(" {");
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            output.push_str(" # ");
        }
        output.push_str(&to_hwp_script(row)?);
    }
    output.push('}');
    Ok(())
}

fn write_text(text: &str, output: &mut String) {
    for character in text.chars() {
        match character {
            '\u{2009}' => output.push('`'),
            '\u{205f}' => output.push_str("``"),
            '\u{2004}' => output.push_str("```"),
            '\u{2002}' => output.push('~'),
            '\u{2003}' => output.push_str("~~"),
            other => output.push(other),
        }
    }
}

fn big_operator_name(symbol: &str) -> &str {
    match symbol {
        "∑" => "sum",
        "∏" => "prod",
        "∐" => "coprod",
        "⋃" => "bigcup",
        "⋂" => "bigcap",
        "⊔" => "bigsqcup",
        "⊎" => "biguplus",
        "⋀" => "bigwedge",
        "⋁" => "bigvee",
        "⊕" => "bigoplus",
        "⊗" => "bigotimes",
        "⊙" => "bigodot",
        "⊖" => "bigominus",
        "⊘" => "bigodiv",
        "∫" => "int",
        "∬" => "dint",
        "∭" => "tint",
        "∮" => "oint",
        "∯" => "odint",
        "∰" => "otint",
        other => other,
    }
}

fn math_symbol_name(symbol: &str) -> &str {
    match symbol {
        "α" => "alpha",
        "β" => "beta",
        "γ" => "gamma",
        "δ" => "delta",
        "ε" => "epsilon",
        "ζ" => "zeta",
        "η" => "eta",
        "θ" => "theta",
        "ϑ" => "vartheta",
        "ι" => "iota",
        "κ" => "kappa",
        "λ" => "lambda",
        "μ" => "mu",
        "ν" => "nu",
        "ξ" => "xi",
        "ο" => "omicron",
        "π" => "pi",
        "ϖ" => "varpi",
        "ρ" => "rho",
        "σ" => "sigma",
        "ς" => "varsigma",
        "τ" => "tau",
        "υ" => "upsilon",
        "φ" => "phi",
        "χ" => "chi",
        "ψ" => "psi",
        "ω" => "omega",
        "Γ" => "Gamma",
        "Δ" => "Delta",
        "Θ" => "Theta",
        "Λ" => "Lambda",
        "Ξ" => "Xi",
        "Π" => "Pi",
        "Σ" => "Sigma",
        "Φ" => "Phi",
        "Ψ" => "Psi",
        "Ω" => "Omega",
        "±" => "pm",
        "∓" => "mp",
        "×" => "times",
        "÷" => "div",
        "·" => "cdot",
        "∘" => "circ",
        "•" => "bullet",
        "≠" => "neq",
        "≤" => "leq",
        "≥" => "geq",
        "≈" => "approx",
        "∼" => "sim",
        "≅" => "cong",
        "≡" => "equiv",
        "∝" => "propto",
        "∞" => "inf",
        "∂" => "partial",
        "∅" => "emptyset",
        "∈" => "in",
        "∉" => "notin",
        "⊂" => "subset",
        "⊃" => "superset",
        "⊆" => "subseteq",
        "⊇" => "supseteq",
        "∪" => "union",
        "∩" => "inter",
        "∀" => "forall",
        "∃" => "exist",
        "¬" => "lnot",
        "∧" => "wedge",
        "∨" => "vee",
        "⊕" => "oplus",
        "⊗" => "otimes",
        "∴" => "therefore",
        "∵" => "because",
        "←" => "larrow",
        "→" => "rarrow",
        "↑" => "uparrow",
        "↓" => "downarrow",
        "↔" => "lrarrow",
        "⇐" => "LARROW",
        "⇒" => "RARROW",
        "⇔" => "LRARROW",
        "↦" => "mapsto",
        "↗" => "nearrow",
        "↘" => "searrow",
        "∫" => "int",
        "∬" => "dint",
        "∭" => "tint",
        "∮" => "oint",
        "∯" => "odint",
        "∰" => "otint",
        "ℓ" => "ell",
        "ℏ" => "hbar",
        "ℵ" => "aleph",
        "⋯" => "cdots",
        "…" => "ldots",
        "⋮" => "vdots",
        "⋱" => "ddots",
        "△" => "triangle",
        "∠" => "angle",
        "⊥" => "bot",
        "°" => "deg",
        "†" => "dagger",
        "‡" => "ddagger",
        "★" => "star",
        "℃" => "CENTIGRADE",
        "′" => "prime",
        other => other,
    }
}

fn bracket_name(value: &str, left: bool) -> &str {
    match value {
        "" => ".",
        "{" => "lbrace",
        "}" => "rbrace",
        "⌈" => "lceil",
        "⌉" => "rceil",
        "⌊" => "lfloor",
        "⌋" => "rfloor",
        "⟨" => "langle",
        "⟩" => "rangle",
        value if value == "(" && !left => ")",
        value if value == ")" && left => "(",
        other => other,
    }
}

fn decoration_name(kind: DecoKind) -> &'static str {
    match kind {
        DecoKind::Hat => "hat",
        DecoKind::Check => "check",
        DecoKind::Tilde => "tilde",
        DecoKind::Acute => "acute",
        DecoKind::Grave => "grave",
        DecoKind::Dot => "dot",
        DecoKind::DDot => "ddot",
        DecoKind::Bar => "bar",
        DecoKind::Vec => "vec",
        DecoKind::Dyad => "dyad",
        DecoKind::Under => "under",
        DecoKind::Arch => "arch",
        DecoKind::Underline => "UNDERLINE",
        DecoKind::Overline => "OVERLINE",
        DecoKind::StrikeThrough => "NOT",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::equation::parser::parse;

    fn canonical(script: &str) -> String {
        to_hwp_script(&parse(script)).expect("supported canonical script")
    }

    #[test]
    fn canonicalizes_common_latex_without_backslash_commands() {
        for script in [
            r"\frac{1}{2}",
            r"x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}",
            r"\sqrt[3]{x}",
            r"x_i^2",
            r"\sum_{i=1}^{n} i",
            r"\int_0^1 x dx",
            r"\left( x \right)^2",
            r"\begin{matrix} a & b \\ c & d \end{matrix}",
            r"\begin{cases} x & \text{if } x \ge 0 \\ -x & \text{otherwise} \end{cases}",
        ] {
            let output = canonical(script);
            assert!(!output.contains('\\'), "{script} -> {output}");
            assert_eq!(parse(&output), parse(script), "{script} -> {output}");
        }
    }

    #[test]
    fn emits_eqedit_names_for_supported_latex_symbols() {
        let script = r"\zeta \Xi \emptyset \subseteq \rightarrow \iint \iiint \oint \aleph \ddots";
        let output = canonical(script);

        assert_eq!(
            output,
            "zeta Xi emptyset subseteq rarrow dint tint oint aleph ddots"
        );
        assert!(!output.contains('\\'));
        assert!(!matches!(parse(&output), EqNode::Empty));
    }

    #[test]
    fn preserves_latex_spacing_with_eqedit_spacing_tokens() {
        assert_eq!(canonical(r"x\,y\quad z"), "x `y ~~z");
    }

    #[test]
    fn rejects_latex_only_font_styles_instead_of_flattening_them() {
        assert_eq!(
            to_hwp_script(&parse(r"\mathbb{R}")),
            Err(CanonicalScriptError::UnsupportedFontStyle(
                FontStyleKind::Blackboard
            )),
        );
    }
}
