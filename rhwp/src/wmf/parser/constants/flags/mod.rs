//! Implementation of the definitions in Section 2.1.2 of the WMF
//! specifications.

mod clip_precision;
mod ext_text_out_options;
mod text_alignment_mode;
mod vertical_text_alignment_mode;

pub use self::{
    clip_precision::*, ext_text_out_options::*, text_alignment_mode::*,
    vertical_text_alignment_mode::*,
};
