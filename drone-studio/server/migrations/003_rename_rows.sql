-- The product is now called Armable. Rename the storage table and its indexes to match.
alter table lucidity_rows rename to armable_rows;
alter index lucidity_rows_recent rename to armable_rows_recent;
alter index lucidity_rows_lookup rename to armable_rows_lookup;
alter index lucidity_rows_owner rename to armable_rows_owner;
