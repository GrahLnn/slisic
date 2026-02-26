pub struct SchemaItem {
    pub ddl: &'static str,
}
inventory::collect!(SchemaItem);

pub trait SchemaDef {
    const SCHEMA: &'static str;
}

#[macro_export]
macro_rules! impl_schema {
    ($ty:ty, $ddl:expr) => {
        impl $crate::database::schema::SchemaDef for $ty {
            const SCHEMA: &'static str = $ddl;
        }

        inventory::submit! {
            $crate::database::schema::SchemaItem {
                ddl: < $ty as $crate::database::schema::SchemaDef >::SCHEMA,
            }
        }
    };
}
