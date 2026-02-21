


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "hypopg" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "index_advisor" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."purchase_status_enum" AS ENUM (
    'PENDING',
    'APPROVED',
    'RECEIVED',
    'CANCELLED'
);


ALTER TYPE "public"."purchase_status_enum" OWNER TO "postgres";


CREATE TYPE "public"."transaction_type_enum" AS ENUM (
    'IN',
    'OUT',
    'ADJUSTMENT',
    'TRANSFER_OUT',
    'TRANSFER_IN'
);


ALTER TYPE "public"."transaction_type_enum" OWNER TO "postgres";


CREATE TYPE "public"."user_role_enum" AS ENUM (
    'SUPER_ADMIN',
    'LAB_MANAGER',
    'STORE_KEEPER',
    'TECHNICIAN',
    'AUDITOR'
);


ALTER TYPE "public"."user_role_enum" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_stock_quantity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN

  IF NEW.transaction_type IN ('OUT','TRANSFER_OUT') THEN

    UPDATE stock_batches
    SET current_quantity = current_quantity - NEW.quantity
    WHERE id = NEW.batch_id
      AND current_quantity >= NEW.quantity;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Insufficient stock for this transaction';
    END IF;

  ELSIF NEW.transaction_type IN ('IN','TRANSFER_IN') THEN

    UPDATE stock_batches
    SET current_quantity = current_quantity + NEW.quantity
    WHERE id = NEW.batch_id;

  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_stock_quantity"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."app_users" (
    "id" "uuid" NOT NULL,
    "laboratory_id" "uuid",
    "full_name" character varying(150),
    "role" "public"."user_role_enum" DEFAULT 'TECHNICIAN'::"public"."user_role_enum" NOT NULL,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "is_active" boolean DEFAULT true
);


ALTER TABLE "public"."app_users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "action" character varying(255) NOT NULL,
    "table_affected" character varying(100),
    "record_id" "uuid",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "details" "jsonb"
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" character varying(100) NOT NULL,
    "description" "text",
    "is_hazardous" boolean DEFAULT false,
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."items" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "category_id" "uuid",
    "name" character varying(255) NOT NULL,
    "sku" character varying(100) NOT NULL,
    "barcode" character varying(100),
    "unit_of_measure" character varying(50) NOT NULL,
    "is_perishable" boolean DEFAULT false,
    "minimum_threshold" numeric(15,2) DEFAULT 0,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "is_active" boolean DEFAULT true
);


ALTER TABLE "public"."items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."laboratories" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" character varying(150) NOT NULL,
    "location" "text",
    "created_at" timestamp without time zone DEFAULT "now"(),
    "is_active" boolean DEFAULT true
);


ALTER TABLE "public"."laboratories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_batches" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "item_id" "uuid" NOT NULL,
    "laboratory_id" "uuid" NOT NULL,
    "supplier_id" "uuid",
    "batch_number" character varying(100),
    "quantity_received" numeric(15,2) NOT NULL,
    "current_quantity" numeric(15,2) NOT NULL,
    "cost_per_unit" numeric(15,2),
    "received_date" "date" NOT NULL,
    "expiry_date" "date",
    "storage_location" character varying(255),
    "created_at" timestamp without time zone DEFAULT "now"(),
    CONSTRAINT "stock_batches_current_quantity_check" CHECK (("current_quantity" >= (0)::numeric)),
    CONSTRAINT "stock_batches_quantity_received_check" CHECK (("quantity_received" > (0)::numeric))
);


ALTER TABLE "public"."stock_batches" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."lab_stock_summary" AS
 SELECT "l"."name" AS "laboratory",
    "i"."name" AS "item",
    "sum"("sb"."current_quantity") AS "total_quantity"
   FROM (("public"."stock_batches" "sb"
     JOIN "public"."items" "i" ON (("sb"."item_id" = "i"."id")))
     JOIN "public"."laboratories" "l" ON (("sb"."laboratory_id" = "l"."id")))
  GROUP BY "l"."name", "i"."name";


ALTER VIEW "public"."lab_stock_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."low_stock_alerts" AS
 SELECT "l"."name" AS "laboratory",
    "i"."name" AS "item",
    "sum"("sb"."current_quantity") AS "total_quantity",
    "i"."minimum_threshold"
   FROM (("public"."stock_batches" "sb"
     JOIN "public"."items" "i" ON (("sb"."item_id" = "i"."id")))
     JOIN "public"."laboratories" "l" ON (("sb"."laboratory_id" = "l"."id")))
  GROUP BY "l"."name", "i"."name", "i"."minimum_threshold"
 HAVING ("sum"("sb"."current_quantity") <= "i"."minimum_threshold");


ALTER VIEW "public"."low_stock_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_orders" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "laboratory_id" "uuid",
    "supplier_id" "uuid",
    "status" "public"."purchase_status_enum" DEFAULT 'PENDING'::"public"."purchase_status_enum",
    "total_amount" numeric(15,2),
    "order_date" "date" DEFAULT CURRENT_DATE,
    "created_by" "uuid"
);


ALTER TABLE "public"."purchase_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_transactions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "transaction_type" "public"."transaction_type_enum" NOT NULL,
    "quantity" numeric(15,2) NOT NULL,
    "transaction_date" timestamp without time zone DEFAULT "now"(),
    "remarks" "text",
    CONSTRAINT "stock_transactions_quantity_check" CHECK (("quantity" > (0)::numeric))
);


ALTER TABLE "public"."stock_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."stock_transfers" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "from_lab_id" "uuid",
    "to_lab_id" "uuid",
    "batch_id" "uuid",
    "quantity" numeric(15,2),
    "transfer_date" timestamp without time zone DEFAULT "now"(),
    "initiated_by" "uuid",
    CONSTRAINT "stock_transfers_quantity_check" CHECK (("quantity" > (0)::numeric))
);


ALTER TABLE "public"."stock_transfers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" character varying(255) NOT NULL,
    "contact_person" character varying(150),
    "email" character varying(150),
    "phone" character varying(50),
    "address" "text",
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_sku_key" UNIQUE ("sku");



ALTER TABLE ONLY "public"."laboratories"
    ADD CONSTRAINT "laboratories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_batches"
    ADD CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_transactions"
    ADD CONSTRAINT "stock_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_batch_expiry" ON "public"."stock_batches" USING "btree" ("expiry_date");



CREATE INDEX "idx_batch_item" ON "public"."stock_batches" USING "btree" ("item_id");



CREATE INDEX "idx_batch_lab" ON "public"."stock_batches" USING "btree" ("laboratory_id");



CREATE INDEX "idx_items_category" ON "public"."items" USING "btree" ("category_id");



CREATE INDEX "idx_transactions_batch" ON "public"."stock_transactions" USING "btree" ("batch_id");



CREATE INDEX "idx_transactions_date" ON "public"."stock_transactions" USING "btree" ("transaction_date");



CREATE OR REPLACE TRIGGER "trg_update_stock" AFTER INSERT ON "public"."stock_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_stock_quantity"();



ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_users"
    ADD CONSTRAINT "app_users_laboratory_id_fkey" FOREIGN KEY ("laboratory_id") REFERENCES "public"."laboratories"("id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."items"
    ADD CONSTRAINT "items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_laboratory_id_fkey" FOREIGN KEY ("laboratory_id") REFERENCES "public"."laboratories"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");



ALTER TABLE ONLY "public"."stock_batches"
    ADD CONSTRAINT "stock_batches_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_batches"
    ADD CONSTRAINT "stock_batches_laboratory_id_fkey" FOREIGN KEY ("laboratory_id") REFERENCES "public"."laboratories"("id");



ALTER TABLE ONLY "public"."stock_batches"
    ADD CONSTRAINT "stock_batches_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");



ALTER TABLE ONLY "public"."stock_transactions"
    ADD CONSTRAINT "stock_transactions_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."stock_transactions"
    ADD CONSTRAINT "stock_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id");



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_from_lab_id_fkey" FOREIGN KEY ("from_lab_id") REFERENCES "public"."laboratories"("id");



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "public"."app_users"("id");



ALTER TABLE ONLY "public"."stock_transfers"
    ADD CONSTRAINT "stock_transfers_to_lab_id_fkey" FOREIGN KEY ("to_lab_id") REFERENCES "public"."laboratories"("id");



CREATE POLICY "Allow authenticated users" ON "public"."laboratories" USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."app_users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."laboratories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_batches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."stock_transactions" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";





























































































































































































GRANT ALL ON FUNCTION "public"."update_stock_quantity"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_stock_quantity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_stock_quantity"() TO "service_role";
























GRANT ALL ON TABLE "public"."app_users" TO "anon";
GRANT ALL ON TABLE "public"."app_users" TO "authenticated";
GRANT ALL ON TABLE "public"."app_users" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";



GRANT ALL ON TABLE "public"."items" TO "anon";
GRANT ALL ON TABLE "public"."items" TO "authenticated";
GRANT ALL ON TABLE "public"."items" TO "service_role";



GRANT ALL ON TABLE "public"."laboratories" TO "anon";
GRANT ALL ON TABLE "public"."laboratories" TO "authenticated";
GRANT ALL ON TABLE "public"."laboratories" TO "service_role";



GRANT ALL ON TABLE "public"."stock_batches" TO "anon";
GRANT ALL ON TABLE "public"."stock_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_batches" TO "service_role";



GRANT ALL ON TABLE "public"."lab_stock_summary" TO "anon";
GRANT ALL ON TABLE "public"."lab_stock_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_stock_summary" TO "service_role";



GRANT ALL ON TABLE "public"."low_stock_alerts" TO "anon";
GRANT ALL ON TABLE "public"."low_stock_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."low_stock_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_orders" TO "anon";
GRANT ALL ON TABLE "public"."purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_orders" TO "service_role";



GRANT ALL ON TABLE "public"."stock_transactions" TO "anon";
GRANT ALL ON TABLE "public"."stock_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."stock_transfers" TO "anon";
GRANT ALL ON TABLE "public"."stock_transfers" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_transfers" TO "service_role";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."suppliers" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

drop trigger if exists "trg_update_stock" on "public"."stock_transactions";

alter table "public"."app_users" drop constraint "app_users_laboratory_id_fkey";

alter table "public"."audit_logs" drop constraint "audit_logs_user_id_fkey";

alter table "public"."items" drop constraint "items_category_id_fkey";

alter table "public"."purchase_orders" drop constraint "purchase_orders_created_by_fkey";

alter table "public"."purchase_orders" drop constraint "purchase_orders_laboratory_id_fkey";

alter table "public"."purchase_orders" drop constraint "purchase_orders_supplier_id_fkey";

alter table "public"."stock_batches" drop constraint "stock_batches_item_id_fkey";

alter table "public"."stock_batches" drop constraint "stock_batches_laboratory_id_fkey";

alter table "public"."stock_batches" drop constraint "stock_batches_supplier_id_fkey";

alter table "public"."stock_transactions" drop constraint "stock_transactions_batch_id_fkey";

alter table "public"."stock_transactions" drop constraint "stock_transactions_user_id_fkey";

alter table "public"."stock_transfers" drop constraint "stock_transfers_batch_id_fkey";

alter table "public"."stock_transfers" drop constraint "stock_transfers_from_lab_id_fkey";

alter table "public"."stock_transfers" drop constraint "stock_transfers_initiated_by_fkey";

alter table "public"."stock_transfers" drop constraint "stock_transfers_to_lab_id_fkey";

alter table "public"."app_users" alter column "role" set default 'TECHNICIAN'::public.user_role_enum;

alter table "public"."app_users" alter column "role" set data type public.user_role_enum using "role"::text::public.user_role_enum;

alter table "public"."audit_logs" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."categories" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."items" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."laboratories" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."purchase_orders" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."purchase_orders" alter column "status" set default 'PENDING'::public.purchase_status_enum;

alter table "public"."purchase_orders" alter column "status" set data type public.purchase_status_enum using "status"::text::public.purchase_status_enum;

alter table "public"."stock_batches" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."stock_transactions" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."stock_transactions" alter column "transaction_type" set data type public.transaction_type_enum using "transaction_type"::text::public.transaction_type_enum;

alter table "public"."stock_transfers" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."suppliers" alter column "id" set default extensions.uuid_generate_v4();

alter table "public"."app_users" add constraint "app_users_laboratory_id_fkey" FOREIGN KEY (laboratory_id) REFERENCES public.laboratories(id) not valid;

alter table "public"."app_users" validate constraint "app_users_laboratory_id_fkey";

alter table "public"."audit_logs" add constraint "audit_logs_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.app_users(id) not valid;

alter table "public"."audit_logs" validate constraint "audit_logs_user_id_fkey";

alter table "public"."items" add constraint "items_category_id_fkey" FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL not valid;

alter table "public"."items" validate constraint "items_category_id_fkey";

alter table "public"."purchase_orders" add constraint "purchase_orders_created_by_fkey" FOREIGN KEY (created_by) REFERENCES public.app_users(id) not valid;

alter table "public"."purchase_orders" validate constraint "purchase_orders_created_by_fkey";

alter table "public"."purchase_orders" add constraint "purchase_orders_laboratory_id_fkey" FOREIGN KEY (laboratory_id) REFERENCES public.laboratories(id) not valid;

alter table "public"."purchase_orders" validate constraint "purchase_orders_laboratory_id_fkey";

alter table "public"."purchase_orders" add constraint "purchase_orders_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) not valid;

alter table "public"."purchase_orders" validate constraint "purchase_orders_supplier_id_fkey";

alter table "public"."stock_batches" add constraint "stock_batches_item_id_fkey" FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE not valid;

alter table "public"."stock_batches" validate constraint "stock_batches_item_id_fkey";

alter table "public"."stock_batches" add constraint "stock_batches_laboratory_id_fkey" FOREIGN KEY (laboratory_id) REFERENCES public.laboratories(id) not valid;

alter table "public"."stock_batches" validate constraint "stock_batches_laboratory_id_fkey";

alter table "public"."stock_batches" add constraint "stock_batches_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) not valid;

alter table "public"."stock_batches" validate constraint "stock_batches_supplier_id_fkey";

alter table "public"."stock_transactions" add constraint "stock_transactions_batch_id_fkey" FOREIGN KEY (batch_id) REFERENCES public.stock_batches(id) ON DELETE CASCADE not valid;

alter table "public"."stock_transactions" validate constraint "stock_transactions_batch_id_fkey";

alter table "public"."stock_transactions" add constraint "stock_transactions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.app_users(id) not valid;

alter table "public"."stock_transactions" validate constraint "stock_transactions_user_id_fkey";

alter table "public"."stock_transfers" add constraint "stock_transfers_batch_id_fkey" FOREIGN KEY (batch_id) REFERENCES public.stock_batches(id) not valid;

alter table "public"."stock_transfers" validate constraint "stock_transfers_batch_id_fkey";

alter table "public"."stock_transfers" add constraint "stock_transfers_from_lab_id_fkey" FOREIGN KEY (from_lab_id) REFERENCES public.laboratories(id) not valid;

alter table "public"."stock_transfers" validate constraint "stock_transfers_from_lab_id_fkey";

alter table "public"."stock_transfers" add constraint "stock_transfers_initiated_by_fkey" FOREIGN KEY (initiated_by) REFERENCES public.app_users(id) not valid;

alter table "public"."stock_transfers" validate constraint "stock_transfers_initiated_by_fkey";

alter table "public"."stock_transfers" add constraint "stock_transfers_to_lab_id_fkey" FOREIGN KEY (to_lab_id) REFERENCES public.laboratories(id) not valid;

alter table "public"."stock_transfers" validate constraint "stock_transfers_to_lab_id_fkey";

create or replace view "public"."lab_stock_summary" as  SELECT l.name AS laboratory,
    i.name AS item,
    sum(sb.current_quantity) AS total_quantity
   FROM ((public.stock_batches sb
     JOIN public.items i ON ((sb.item_id = i.id)))
     JOIN public.laboratories l ON ((sb.laboratory_id = l.id)))
  GROUP BY l.name, i.name;


create or replace view "public"."low_stock_alerts" as  SELECT l.name AS laboratory,
    i.name AS item,
    sum(sb.current_quantity) AS total_quantity,
    i.minimum_threshold
   FROM ((public.stock_batches sb
     JOIN public.items i ON ((sb.item_id = i.id)))
     JOIN public.laboratories l ON ((sb.laboratory_id = l.id)))
  GROUP BY l.name, i.name, i.minimum_threshold
 HAVING (sum(sb.current_quantity) <= i.minimum_threshold);


CREATE TRIGGER trg_update_stock AFTER INSERT ON public.stock_transactions FOR EACH ROW EXECUTE FUNCTION public.update_stock_quantity();


