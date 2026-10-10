using System;
using System.Collections;
using System.Data.Common;
using System.Data.SqlTypes;
using System.IO;
using System.Linq;
using System.Threading;
using D365MetadataBridge.Services;

// Enforces forward-only field access, including no GetValue after chunk reads.
// This is a reader contract double, not a substitute for the live SqlClient checks.
internal static class SequentialCellChecks
{
    public static void Run()
    {
        foreach (var type in new[] { "nvarchar", "varchar", "nchar", "char", "ntext", "text" })
        foreach (var value in new[] { "", "AxDB", "caffè 界 😀", new string('界', 9000), new string('x', AxDbSqlService.ResponseByteLimit / 2) })
        {
            using (var reader = new ForwardReader(new[] { type, "int" }, new object[] { value, 42 }))
            {
                Equal(AxDbSqlService.Cell(reader, 0), value, type + " text");
                Equal(AxDbSqlService.Cell(reader, 1), 42, "column after text");
            }
        }
        // SqlClient refuses GetStream on timestamp/rowversion ("Invalid attempt to GetStream on column
        // 'SYSROWVERSION'"), which every AxDB table carries; the double refuses it the same way.
        foreach (var type in new[] { "timestamp", "rowversion" })
        {
            var version = new byte[] { 0, 0, 0, 0, 0, 1, 2, 3 };
            using (var reader = new ForwardReader(new[] { "int", type, "nvarchar" }, new object[] { 1, version, "after" }))
            {
                Equal(AxDbSqlService.Cell(reader, 0), 1, "column before " + type);
                Equal(AxDbSqlService.Cell(reader, 1), Convert.ToBase64String(version), type + " read as 8 bytes");
                Equal(AxDbSqlService.Cell(reader, 2), "after", "column after " + type);
            }
        }
        foreach (var type in new[] { "varbinary", "binary", "image" })
        foreach (var length in new[] { 0, 8, 9000, AxDbSqlService.ResponseByteLimit / 2 })
        {
            var data = Enumerable.Range(0, length).Select(i => (byte)(i % 256)).ToArray();
            using (var reader = new ForwardReader(new[] { type, "int" }, new object[] { data, 7 }))
            {
                Equal(AxDbSqlService.Cell(reader, 0), Convert.ToBase64String(data), type + " binary");
                Equal(AxDbSqlService.Cell(reader, 1), 7, "column after binary");
            }
        }
        using (var reader = new ForwardReader(new[] { "nvarchar", "varchar", "varbinary", "bigint", "decimal", "nvarchar" },
            new object[] { DBNull.Value, "", DBNull.Value, long.MaxValue, SqlDecimal.Parse("123456789012345678901234567890.12345678"), "last" }))
        {
            var expected = new object?[] { null, "", null, "9223372036854775807", "123456789012345678901234567890.12345678", "last" };
            for (var i = 0; i < expected.Length; i++) Equal(AxDbSqlService.Cell(reader, i), expected[i], "mixed column " + i);
        }
        foreach (var type in new[] { "nvarchar", "varbinary" })
        {
            object value = type == "nvarchar" ? (object)new string('x', AxDbSqlService.ResponseByteLimit / 2 + 1) : new byte[AxDbSqlService.ResponseByteLimit / 2 + 1];
            using (var reader = new ForwardReader(new[] { type }, new[] { value }))
            {
                try { AxDbSqlService.Cell(reader, 0); throw new Exception("Oversized cell accepted"); }
                catch (Exception e) when (e.Message.Contains("response budget")) { }
                if (reader.UnitsRead > AxDbSqlService.ResponseByteLimit / 2 + 1) throw new Exception("Unbounded cell read");
            }
            using (var cancellation = new CancellationTokenSource())
            using (var reader = new ForwardReader(new[] { type }, new[] { value }) { AfterChunk = cancellation.Cancel })
            {
                try { AxDbSqlService.Cell(reader, 0, cancellation.Token); throw new Exception("Cancellation ignored"); }
                catch (OperationCanceledException) { }
                if (reader.UnitsRead > 997) throw new Exception("Read continued after cancellation");
            }
        }
        Console.WriteLine("PASS: forward-only text/binary/rowversion cells, short chunks, empty/NULL, mixed ordinals, exact numerics and cell limits");
    }

    private static void Equal(object? actual, object? expected, string message)
    { if (!Equals(actual, expected)) throw new Exception("FAIL: " + message); }

    private sealed class ForwardReader : DbDataReader
    {
        private readonly string[] types;
        private readonly object[] values;
        private int column = -1;
        private long offset;
        private bool chunked, consumed;
        public long UnitsRead { get; private set; }
        public Action? AfterChunk { get; set; }
        public ForwardReader(string[] types, object[] values) { this.types = types; this.values = values; }
        private void Enter(int ordinal)
        {
            if (ordinal < column) throw new InvalidOperationException("SequentialAccess: previous column");
            if (ordinal > column) { column = ordinal; offset = 0; chunked = consumed = false; }
        }
        public override object GetValue(int ordinal)
        {
            Enter(ordinal);
            if (chunked || consumed) throw new InvalidOperationException("SequentialAccess: cannot reread a consumed or chunked column");
            if (values[ordinal] is string || values[ordinal] is byte[]) throw new InvalidOperationException("Variable-size cells must use bounded chunk reads");
            consumed = true;
            return values[ordinal];
        }
        public override object GetProviderSpecificValue(int ordinal) => GetValue(ordinal);
        public override bool IsDBNull(int ordinal) { Enter(ordinal); return values[ordinal] == DBNull.Value; }
        private int Chunk(int ordinal, long dataOffset, Array? buffer, int bufferOffset, int length, int total)
        {
            Enter(ordinal);
            if (consumed || dataOffset != offset) throw new InvalidOperationException("SequentialAccess: invalid chunk offset");
            chunked = true;
            if (buffer == null) return total;
            // Short reads exercise loop correctness, including exact-cap EOF detection.
            var count = Math.Min(Math.Min(length, 997), total - (int)offset);
            offset += count; UnitsRead += count; AfterChunk?.Invoke();
            return count;
        }
        public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length)
        {
            var value = (string)values[ordinal];
            var count = Chunk(ordinal, dataOffset, buffer, bufferOffset, length, value.Length);
            if (buffer != null) value.CopyTo((int)dataOffset, buffer, bufferOffset, count);
            return count;
        }
        public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length)
        {
            var value = (byte[])values[ordinal];
            var count = Chunk(ordinal, dataOffset, buffer, bufferOffset, length, value.Length);
            if (buffer != null) Array.Copy(value, dataOffset, buffer, bufferOffset, count);
            return count;
        }
        public override TextReader GetTextReader(int ordinal) { Enter(ordinal); return new ForwardText(this, ordinal); }
        public override Stream GetStream(int ordinal)
        {
            if (types[ordinal] == "timestamp" || types[ordinal] == "rowversion")
                throw new InvalidOperationException("Invalid attempt to GetStream on column 'c" + ordinal + "'.");
            Enter(ordinal);
            return new ForwardBinary(this, ordinal);
        }
        private sealed class ForwardText : TextReader
        {
            private readonly ForwardReader owner; private readonly int ordinal; private long offset;
            public ForwardText(ForwardReader owner, int ordinal) { this.owner = owner; this.ordinal = ordinal; }
            public override int Read(char[] buffer, int index, int count)
            { var read = (int)owner.GetChars(ordinal, offset, buffer, index, count); offset += read; return read; }
        }
        private sealed class ForwardBinary : Stream
        {
            private readonly ForwardReader owner; private readonly int ordinal; private long offset;
            public ForwardBinary(ForwardReader owner, int ordinal) { this.owner = owner; this.ordinal = ordinal; }
            public override int Read(byte[] buffer, int index, int count)
            { var read = (int)owner.GetBytes(ordinal, offset, buffer, index, count); offset += read; return read; }
            public override bool CanRead => true;
            public override bool CanWrite => false;
            public override bool CanSeek => false;
            public override long Length => throw new NotSupportedException();
            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
            public override void SetLength(long value) => throw new NotSupportedException();
            public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            public override void Flush() { }
        }
        public override string GetDataTypeName(int ordinal) => types[ordinal];
        public override int FieldCount => values.Length;
        public override string GetName(int ordinal) => "c" + ordinal;
        public override int GetOrdinal(string name) => int.Parse(name.Substring(1));
        public override Type GetFieldType(int ordinal) => values[ordinal].GetType();
        public override object this[int ordinal] => GetValue(ordinal);
        public override object this[string name] => GetValue(GetOrdinal(name));
        public override bool HasRows => true;
        public override bool IsClosed => false;
        public override int Depth => 0;
        public override int RecordsAffected => -1;
        public override bool Read() => throw new NotSupportedException();
        public override bool NextResult() => false;
        public override IEnumerator GetEnumerator() => throw new NotSupportedException();
        public override int GetValues(object[] output) => throw new NotSupportedException();
        public override bool GetBoolean(int ordinal) => (bool)GetValue(ordinal);
        public override byte GetByte(int ordinal) => (byte)GetValue(ordinal);
        public override char GetChar(int ordinal) => (char)GetValue(ordinal);
        public override DateTime GetDateTime(int ordinal) => (DateTime)GetValue(ordinal);
        public override decimal GetDecimal(int ordinal) => (decimal)GetValue(ordinal);
        public override double GetDouble(int ordinal) => (double)GetValue(ordinal);
        public override float GetFloat(int ordinal) => (float)GetValue(ordinal);
        public override Guid GetGuid(int ordinal) => (Guid)GetValue(ordinal);
        public override short GetInt16(int ordinal) => (short)GetValue(ordinal);
        public override int GetInt32(int ordinal) => (int)GetValue(ordinal);
        public override long GetInt64(int ordinal) => (long)GetValue(ordinal);
        public override string GetString(int ordinal) => (string)GetValue(ordinal);
    }
}
