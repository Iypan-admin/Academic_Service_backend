const supabase = require("../config/supabase.js");
const nodemailer = require("nodemailer");
require("dotenv").config(); // to load .env

const createBatch = async (req, res) => {
    const { duration, center, teacher, course_id, time_from, time_to } = req.body;

    if (!duration || !center || !teacher || !course_id || !time_from || !time_to) {
        return res.status(400).json({
            error: "All fields are required: duration, center, teacher, course_id, time_from, time_to"
        });
    }

    try {
        // 1. Get the latest batch_name to increment
        const { data: lastBatch, error: fetchError } = await supabase
            .from("batches")
            .select("batch_name")
            .like("batch_name", "B%")
            .order("batch_name", { ascending: false })
            .limit(1)
            .single();

        let newBatchNumber = 118; // default start
        if (lastBatch && lastBatch.batch_name) {
            const match = lastBatch.batch_name.match(/^B(\d+)/);
            if (match) {
                newBatchNumber = parseInt(match[1]) + 1;
            }
        }

        // 2. Get course name
        const { data: courseExists, error: courseError } = await supabase
            .from("courses")
            .select("course_name")
            .eq("id", course_id)
            .single();

        if (courseError || !courseExists) {
            return res.status(400).json({ error: "Invalid course ID" });
        }

        // 3. Construct batch_name
        const courseName = courseExists.course_name.toUpperCase(); // Keep as it is
        // Convert to AM/PM format
        const formatToAmPm = (time) => {
            const [hours, minutes] = time.split(':');
            const date = new Date();
            date.setHours(hours, minutes);
            return date.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            }).replace(/\s/g, ''); // Remove space before AM/PM
        };

        const formattedFrom = formatToAmPm(time_from);
        const formattedTo = formatToAmPm(time_to);

        const batch_name = `B${newBatchNumber}-${courseName}-${formattedFrom}-${formattedTo}`;



        // 4. Insert into batches
        const { data, error } = await supabase
            .from("batches")
            .insert([{
                batch_name,
                duration,
                center,
                teacher,
                course_id,
                time_from,
                time_to
            }])
            .select(`
                *,
                course:courses(id, course_name, type)
            `)
            .single();

        if (error) {
            console.error("Database error:", error);
            return res.status(400).json({ error: error.message });
        }

        res.status(201).json({
            message: "Batch created successfully",
            batch: {
                ...data,
                course_name: data.course?.course_name,
                course_type: data.course?.type
            }
        });
    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

const getBatches = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("batches")
            .select(`
                *,
                center_details:centers(center_id, center_name),
                teacher_details:teachers!inner(
                    teacher_info:users(id, name)
                ),
                course:courses(id, course_name, type)
            `);

        if (error) {
            console.error("Database error:", error);
            return res.status(400).json({ error: error.message });
        }

        // Update transformed data to use course type from courses table
        const transformedData = data.map(batch => ({
            ...batch,
            center_name: batch.center_details?.center_name,
            teacher_name: batch.teacher_details?.teacher_info?.name,
            course_name: batch.course?.course_name,
            course_type: batch.course?.type,
            // Remove the nested objects
            center_details: undefined,
            teacher_details: undefined,
            course: undefined
        }));

        res.json({
            success: true,
            data: transformedData
        });
    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
};

const getBatchById = async (req, res) => {
    const { id } = req.params;

    const { data, error } = await supabase
        .from("batches")
        .select(`
            *,
            course:courses(id, course_name)
        `)
        .eq("batch_id", id)
        .single();

    if (error) return res.status(400).json({ error: error.message });

    res.json(data);
};

const updateBatch = async (req, res) => {
    const { id } = req.params;
    const { batch_name, duration, center, teacher, course_id, time_from, time_to } = req.body;

    const { data, error } = await supabase
        .from("batches")
        .update({ batch_name, duration, center, teacher, course_id, time_from, time_to })
        .eq("batch_id", id)
        .select();

    if (error) return res.status(400).json({ error: error.message });

    res.json({ message: "Batch updated successfully", batch: data });
};

const deleteBatch = async (req, res) => {
    const { id } = req.params;

    const { error } = await supabase.from("batches").delete().eq("batch_id", id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ message: "Batch deleted successfully" });
};


const approveStudent = async (req, res) => {
    const { student_id } = req.body;

    if (!student_id) {
        return res.status(400).json({ error: "Student ID is required" });
    }

    // Fetch student details including state, center, and status
    const { data: student, error: fetchError } = await supabase
        .from("students")
        .select(`state:states(state_name), center:centers(center_name), status, email, name`)
        .eq("student_id", student_id)
        .single();

    if (fetchError || !student) {
        return res.status(400).json({ error: "Student not found or database error" });
    }

    if (student.status) {
        return res.status(400).json({ error: "Student is already approved" });
    }

    // Extract codes
    const stateCode = student.state?.state_name?.slice(0, 2).toUpperCase() || "XX";
    const centerCode = student.center?.center_name?.slice(0, 2).toUpperCase() || "YY";
    const nextNumber = Math.floor(1000 + Math.random() * 9000);
    const registrationNumber = `ISML${stateCode}${centerCode}${nextNumber}`;

    // Approve student in DB
    const { data, error } = await supabase
        .from("students")
        .update({ status: true, registration_number: registrationNumber })
        .eq("student_id", student_id)
        .select();

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    // Setup mail transport
    const transporter = nodemailer.createTransport({
        service: "Gmail",
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASSWORD
        }
    });

    const mailOptions = {
        from: process.env.MAIL_USER,
        to: student.email,
        subject: "🎉 ISML Registration Approved",
        text: `Hi ${student.name},\n\nCongratulations! Your ISML registration has been approved.\n\nYour Registration Number is: ${registrationNumber}\n\nRegards,\nTeam ISML`
    };

    // Send email
    transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
            console.error("❌ Email sending failed:", err);
        } else {
            console.log("✅ Email sent:", info.response);
        }
    });

    res.json({ message: "Student approved successfully and email sent", student: data });
};


// ✅ Corrected Export
module.exports = { createBatch, getBatches, getBatchById, updateBatch, deleteBatch, approveStudent };
