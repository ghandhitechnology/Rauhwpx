/// The META_CHORD Record draws a chord, which is defined by a region bounded by
/// the intersection of an ellipse with a line segment. The chord is outlined
/// using the pen and filled using the brush that are defined in the playback
/// device context.
#[derive(Clone, Debug)]
pub struct META_CHORD {
    /// RecordSize (4 bytes): A 32-bit unsigned integer that defines the number
    /// of WORD structures, defined in [MS-DTYP] section 2.2.61, in the WMF
    /// record.
    pub record_size: crate::wmf::parser::RecordSize,
    /// RecordFunction (2 bytes): A 16-bit unsigned integer that defines this
    /// WMF record type. The lower byte MUST match the lower byte of the
    /// RecordType Enumeration table value META_CHORD.
    pub record_function: u16,
    /// YRadial2 (2 bytes): A 16-bit signed integer that defines the
    /// y-coordinate, in logical coordinates, of the endpoint of the second
    /// radial.
    pub y_radial2: i16,
    /// XRadial2 (2 bytes): A 16-bit signed integer that defines the
    /// x-coordinate, in logical coordinates, of the endpoint of the second
    /// radial.
    pub x_radial2: i16,
    /// YRadial1 (2 bytes): A 16-bit signed integer that defines the
    /// y-coordinate, in logical coordinates, of the endpoint of the first
    /// radial.
    pub y_radial1: i16,
    /// XRadial1 (2 bytes): A 16-bit signed integer that defines the
    /// x-coordinate, in logical coordinates, of the endpoint of the first
    /// radial.
    pub x_radial1: i16,
    /// BottomRect (2 bytes): A 16-bit signed integer that defines the
    /// y-coordinate, in logical units, of the lower-right corner of the
    /// bounding rectangle.
    pub bottom_rect: i16,
    /// RightRect (2 bytes): A 16-bit signed integer that defines the
    /// x-coordinate, in logical units, of the lower-right corner of the
    /// bounding rectangle.
    pub right_rect: i16,
    /// TopRect (2 bytes): A 16-bit signed integer that defines the
    /// y-coordinate, in logical units, of the upper-left corner of the
    /// bounding rectangle.
    pub top_rect: i16,
    /// LeftRect (2 bytes): A 16-bit signed integer that defines the
    /// x-coordinate, in logical units, of the upper-left corner of the
    /// bounding rectangle.
    pub left_rect: i16,
}

impl META_CHORD {
    #[cfg_attr(feature = "tracing", tracing::instrument(
        level = tracing::Level::TRACE,
        skip_all,
        fields(
            %record_size,
            record_function = %format!("{record_function:#06X}"),
        ),
        err(level = tracing::Level::ERROR, Display),
    ))]
    pub fn parse<R: crate::wmf::Read>(
        buf: &mut R,
        mut record_size: crate::wmf::parser::RecordSize,
        record_function: u16,
    ) -> Result<Self, crate::wmf::parser::ParseError> {
        crate::wmf::parser::records::check_lower_byte_matches(
            record_function,
            crate::wmf::parser::RecordType::META_CHORD,
        )?;

        let (
            (y_radial2, y_radial2_bytes),
            (x_radial2, x_radial2_bytes),
            (y_radial1, y_radial1_bytes),
            (x_radial1, x_radial1_bytes),
            (bottom_rect, bottom_rect_bytes),
            (right_rect, right_rect_bytes),
            (top_rect, top_rect_bytes),
            (left_rect, left_rect_bytes),
        ) = (
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
            crate::wmf::parser::read_i16_from_le_bytes(buf)?,
        );
        record_size.consume(
            y_radial2_bytes
                + x_radial2_bytes
                + y_radial1_bytes
                + x_radial1_bytes
                + bottom_rect_bytes
                + right_rect_bytes
                + top_rect_bytes
                + left_rect_bytes,
        );

        crate::wmf::parser::records::consume_remaining_bytes(buf, record_size)?;

        Ok(Self {
            record_size,
            record_function,
            y_radial2,
            x_radial2,
            y_radial1,
            x_radial1,
            bottom_rect,
            right_rect,
            top_rect,
            left_rect,
        })
    }
}
