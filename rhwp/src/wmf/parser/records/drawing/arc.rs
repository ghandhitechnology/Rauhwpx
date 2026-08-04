/// The META_ARC Record draws an elliptical arc.
#[derive(Clone, Debug)]
pub struct META_ARC {
    /// RecordSize (4 bytes): A 32-bit unsigned integer that defines the number
    /// of WORD structures, defined in [MS-DTYP] section 2.2.61, in the WMF
    /// record.
    pub record_size: crate::wmf::parser::RecordSize,
    /// RecordFunction (2 bytes): A 16-bit unsigned integer that defines this
    /// WMF record type. The lower byte MUST match the lower byte of the
    /// RecordType Enumeration table value META_ARC.
    pub record_function: u16,
    /// YEndArc (2 bytes): A 16-bit signed integer that defines the
    /// y-coordinate, in logical units, of the ending point of the radial line
    /// defining the ending point of the arc.
    pub y_end_arc: i16,
    /// XEndArc (2 bytes): A 16-bit signed integer that defines the
    /// x-coordinate, in logical units, of the ending point of the radial line
    /// defining the ending point of the arc.
    pub x_end_arc: i16,
    /// YStartArc (2 bytes): A 16-bit signed integer that defines the
    /// y-coordinate, in logical units, of the ending point of the radial line
    /// defining the starting point of the arc.
    pub y_start_arc: i16,
    /// XStartArc (2 bytes): A 16-bit signed integer that defines the
    /// x-coordinate, in logical units, of the ending point of the radial line
    /// defining the starting point of the arc.
    pub x_start_arc: i16,
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

impl META_ARC {
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
            crate::wmf::parser::RecordType::META_ARC,
        )?;

        let (
            (y_end_arc, y_end_arc_bytes),
            (x_end_arc, x_end_arc_bytes),
            (y_start_arc, y_start_arc_bytes),
            (x_start_arc, x_start_arc_bytes),
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
            y_end_arc_bytes
                + x_end_arc_bytes
                + y_start_arc_bytes
                + x_start_arc_bytes
                + bottom_rect_bytes
                + right_rect_bytes
                + top_rect_bytes
                + left_rect_bytes,
        );

        crate::wmf::parser::records::consume_remaining_bytes(buf, record_size)?;

        Ok(Self {
            record_size,
            record_function,
            y_end_arc,
            x_end_arc,
            y_start_arc,
            x_start_arc,
            bottom_rect,
            right_rect,
            top_rect,
            left_rect,
        })
    }
}
