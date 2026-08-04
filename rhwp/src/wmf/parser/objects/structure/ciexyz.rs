/// The CIEXYZ Object defines information about the CIEXYZ chromaticity object.
#[derive(Clone, Debug)]
pub struct CIEXYZ {
    /// ciexyzX (4 bytes): A 32-bit 2.30 fixed point type that defines the x
    /// chromaticity value.
    pub x: u32,
    /// ciexyzY (4 bytes): A 32-bit 2.30 fixed point type that defines the y
    /// chromaticity value.
    pub y: u32,
    /// ciexyzZ (4 bytes): A 32-bit 2.30 fixed point type that defines the z
    /// chromaticity value.
    pub z: u32,
}

impl CIEXYZ {
    #[cfg_attr(feature = "tracing", tracing::instrument(
        level = tracing::Level::TRACE,
        skip_all,
        err(level = tracing::Level::ERROR, Display),
    ))]
    pub fn parse<R: crate::wmf::Read>(
        buf: &mut R,
    ) -> Result<(Self, usize), crate::wmf::parser::ParseError> {
        let ((x, x_bytes), (y, y_bytes), (z, z_bytes)) = (
            crate::wmf::parser::read_u32_from_le_bytes(buf)?,
            crate::wmf::parser::read_u32_from_le_bytes(buf)?,
            crate::wmf::parser::read_u32_from_le_bytes(buf)?,
        );

        Ok((Self { x, y, z }, x_bytes + y_bytes + z_bytes))
    }
}
