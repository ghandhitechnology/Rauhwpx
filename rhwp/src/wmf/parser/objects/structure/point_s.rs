/// The PointS Object defines the x- and y-coordinates of a point.
#[derive(Clone, Debug)]
pub struct PointS {
    /// x (2 bytes): A 16-bit signed integer that defines the horizontal (x)
    /// coordinate of the point.
    pub x: i16,
    /// y (2 bytes): A 16-bit signed integer that defines the vertical (y)
    /// coordinate of the point.
    pub y: i16,
}

impl PointS {
    #[cfg_attr(feature = "tracing", tracing::instrument(
        level = tracing::Level::TRACE,
        skip_all,
        err(level = tracing::Level::ERROR, Display),
    ))]
    pub fn parse<R: crate::wmf::Read>(
        buf: &mut R,
    ) -> Result<(Self, usize), crate::wmf::parser::ParseError> {
        let ((x, x_bytes), (y, y_bytes)) = (
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
        );

        Ok((Self { x, y }, x_bytes + y_bytes))
    }
}
