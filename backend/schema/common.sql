CREATE OR REPLACE FUNCTION director_touch_timestamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.createtime := OLD.createtime;
    NEW.updatetime := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    RETURN NEW;
END;
$$;
