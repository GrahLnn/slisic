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
        impl $crate::model::schema::SchemaDef for $ty {
            const SCHEMA: &'static str = $ddl;
        }

        inventory::submit! {
            $crate::model::schema::SchemaItem {
                ddl: < $ty as $crate::model::schema::SchemaDef >::SCHEMA,
            }
        }
    };
}
