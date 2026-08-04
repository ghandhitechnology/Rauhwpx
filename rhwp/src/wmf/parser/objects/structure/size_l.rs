/// The SizeL Object defines the x- and y-extents of a rectangle.
#[derive(Clone, Debug)]
pub struct SizeL {
    /// cx (4 bytes): A 32-bit unsigned integer that defines the x-coordinate
    /// of the point.
    pub cx: u32,
    /// cy (4 bytes): A 32-bit unsigned integer that defines the y-coordinate
    /// of the point.
    pub cy: u32,
}

impl SizeL {
    #[cfg_attr(feature = "tracing", tracing::instrument(
        level = tracing::Level::TRACE,
        skip_all,
        err(level = tracing::Level::ERROR, Display),
    ))]
    pub fn parse<R: crate::wmf::Read>(
        buf: &mut R,
    ) -> Result<(Self, usize), crate::wmf::parser::ParseError> {
        let ((cx, cx_bytes), (cy, cy_bytes)) = (
            crate::wmf::parser::read_u32_from_le_bytes(buf)?,
            crate::wmf::parser::read_u32_from_le_bytes(buf)?,
        );

        Ok((Self { cx, cy }, cx_bytes + cy_bytes))
    }
}
