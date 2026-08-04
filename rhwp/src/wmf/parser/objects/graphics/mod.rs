//! Implementation of the definitions in Section 2.2.1 of the WMF
//! specifications.

mod brush;
mod font;
mod palette;
mod pen;
mod region;

pub use self::{brush::*, font::*, palette::*, pen::*, region::*};
